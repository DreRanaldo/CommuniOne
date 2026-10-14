// Cart (Stage C, migration 33) against the real local Supabase: the server
// prices every line, limits quantities to stock, refuses own listings and
// services, and keeps carts private and per community.
//
//   A: owner (Owner), seller (Member), buyer (Member)    B: other (Owner)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'other');
  c.A = await community(u.owner, 'CartA');
  c.B = await community(u.other, 'CartB');
  await addMember(c.A, u.seller.id, 'Member');
  await addMember(c.A, u.buyer.id, 'Member');
  const m = u.seller.services.marketplace;
  await m.saveSellerProfile(c.A!, { displayName: 'Seller' });
  const cats = await m.categories();
  const product = (title: string, priceMinor: number) =>
    m.createListing({ communityId: c.A!, kind: 'product', categoryId: cats.find((x) => x.slug === 'electronics')!.id, title, condition: 'new', priceMinor, fulfillment: ['pickup'], publish: true });
  id.radio = (await product('Radio', 500_000)).id;
  id.lamp = (await product('Lamp', 250_000)).id;
  await m.setStock(id.radio, 3);
  await m.setStock(id.lamp, 1);
  id.service = (await m.createListing({ communityId: c.A!, kind: 'service', categoryId: cats.find((x) => x.slug === 'cleaning')!.id, title: 'Cleaning', priceMinor: 300_000, publish: true })).id;
});
after(() => cleanupCommunityContent(Object.values(c)));

test('the server prices the cart; quantities are limited to stock', async () => {
  const cart = u.buyer.services.cart;
  await cart.setQuantity(id.radio!, 2);
  await cart.setQuantity(id.lamp!, 1);
  const q = await cart.quote(c.A!);
  assert.equal(q.subtotalMinor, 1_250_000);
  assert.equal(q.itemCount, 3);
  assert.equal(q.ready, true);
  assert.deepEqual(q.sellers.map((s) => s.subtotalMinor), [1_250_000]);
  assert.equal(await cart.count(c.A!), 3);
  await rejects(cart.setQuantity(id.radio!, 4), ErrorCode.Validation);
  await rejects(cart.setQuantity(id.service!, 1), ErrorCode.Validation);
});

test('a price or stock change is flagged, never silently charged at the old price', async () => {
  await u.seller.services.marketplace.updateListing(id.radio!, { priceMinor: 550_000 });
  await u.seller.services.marketplace.setStock(id.lamp!, 0);
  const q = await u.buyer.services.cart.quote(c.A!);
  const radio = q.lines.find((l) => l.listingId === id.radio)!;
  assert.equal(radio.issue, 'price_changed');
  assert.equal(radio.lineTotalMinor, 1_100_000);
  assert.equal(q.lines.find((l) => l.listingId === id.lamp)!.issue, 'out_of_stock');
  assert.equal(q.subtotalMinor, 1_100_000);
  assert.equal(q.ready, false);
});

test('own listings, other communities and other carts are off limits', async () => {
  await rejects(u.seller.services.cart.setQuantity(id.radio!, 1), ErrorCode.Validation);
  await rejects(u.other.services.cart.setQuantity(id.radio!, 1), ErrorCode.NotFound);
  await rejects(u.other.services.cart.quote(c.A!), ErrorCode.Forbidden);
  assert.equal(await u.owner.services.cart.count(c.A!), 0, "the buyer's cart is private");
  await u.buyer.services.cart.clear(c.A!);
  assert.equal((await u.buyer.services.cart.quote(c.A!)).lines.length, 0);
});

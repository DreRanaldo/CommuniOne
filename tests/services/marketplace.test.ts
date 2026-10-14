// Marketplace catalog (Stage B, migration 32) against the real local
// Supabase: shops, listings, pictures (private bucket), stock, search,
// favorites, moderation, and isolation between communities (decision D1).
//
//   A: owner (Owner), seller (Member), buyer (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'other', TestUser>;
const c: Record<string, string> = {};
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => i % 256), 0xff, 0xd9]);
let laptop = '';

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'other');
  c.A = await community(u.owner, 'MarketA');
  c.B = await community(u.other, 'MarketB');
  await addMember(c.A, u.seller.id, 'Member');
  await addMember(c.A, u.buyer.id, 'Member');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('selling', () => {
  test('a member opens a shop, lists a product with a picture and stock', async () => {
    const m = u.seller.services.marketplace;
    await rejects(m.createListing({ communityId: c.A!, kind: 'product', categoryId: (await m.categories('product'))[0]!.id, title: 'No shop yet' }), ErrorCode.Conflict);
    const shop = await m.saveSellerProfile(c.A!, { displayName: 'Seller Shop', bio: 'Gadgets' });
    assert.equal(shop.verified, false);
    const electronics = (await m.categories('product')).find((x) => x.slug === 'electronics')!;
    const listing = await m.createListing({
      communityId: c.A!, kind: 'product', categoryId: electronics.id, title: 'Used laptop', description: 'Fast, 8GB RAM',
      condition: 'good', priceMinor: 4_500_000, fulfillment: ['pickup', 'seller_delivery'], publish: true,
    });
    laptop = listing.id;
    assert.equal(listing.status, 'active');
    const { path } = await m.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' });
    const image = await m.addImage(listing.id, { path, width: 800, height: 600 });
    assert.ok(image.url);
    assert.deepEqual(await m.setStock(listing.id, 3), { onHand: 3, reserved: 0, available: 3 });
    await rejects(m.setStock(listing.id, -1), ErrorCode.Validation);
  });

  test('a service with a quote and no stock', async () => {
    const m = u.seller.services.marketplace;
    const tech = (await m.categories('service')).find((x) => x.slug === 'tech-help')!;
    const service = await m.createListing({ communityId: c.A!, kind: 'service', categoryId: tech.id, title: 'Phone repair', pricing: 'quote', priceMinor: null, serviceArea: 'Kingston', publish: true });
    assert.equal(service.price_minor, null);
    await rejects(m.setStock(service.id, 2), ErrorCode.Validation);
  });
});

describe('buying side', () => {
  test('members search, filter, open and save listings', async () => {
    const m = u.buyer.services.marketplace;
    const found = await m.search({ communityId: c.A!, query: 'laptops' });
    assert.deepEqual(found.items.map((x) => x.title), ['Used laptop']);
    const card = found.items[0]!;
    assert.equal(card.available, 3);
    assert.ok(card.coverUrl, 'cover picture through a signed link');
    assert.equal(card.priceMinor, 4_500_000);
    assert.deepEqual((await m.search({ communityId: c.A!, kind: 'service' })).items.map((x) => x.title), ['Phone repair']);
    assert.deepEqual((await m.search({ communityId: c.A!, maxPriceMinor: 1_000_000, kind: 'product' })).items, []);
    const detail = await m.listing(laptop);
    assert.equal(detail.seller?.displayName, 'Seller Shop');
    assert.equal(detail.isMine, false);
    assert.equal(detail.images.length, 1);
    await m.setFavorite(laptop, true);
    await m.setFavorite(laptop, true); // idempotent
    assert.deepEqual((await m.search({ communityId: c.A!, favoritesOnly: true })).items.map((x) => x.id), [laptop]);
    await m.setFavorite(laptop, false);
    assert.deepEqual((await m.search({ communityId: c.A!, favoritesOnly: true })).items, []);
  });

  test('nobody else edits a listing or its stock; the server re-checks prices', async () => {
    const m = u.buyer.services.marketplace;
    await rejects(m.updateListing(laptop, { priceMinor: 1 }), ErrorCode.Forbidden);
    await rejects(m.setStock(laptop, 100), ErrorCode.NotFound);
    await rejects(u.seller.services.marketplace.updateListing(laptop, { priceMinor: -5 }), ErrorCode.Validation);
  });
});

describe('isolation and moderation', () => {
  test('another community sees and saves nothing', async () => {
    const m = u.other.services.marketplace;
    await rejects(m.search({ communityId: c.A! }), ErrorCode.Forbidden);
    await rejects(m.listing(laptop), ErrorCode.NotFound);
    await rejects(m.setFavorite(laptop, true), ErrorCode.Forbidden);
    await rejects(m.saveSellerProfile(c.A!, { displayName: 'Intruder' }), ErrorCode.Forbidden);
  });

  test('a manager removes a listing with a reason and suspends a seller', async () => {
    const owner = u.owner.services.marketplace;
    await rejects(owner.updateListing(laptop, { title: 'Hijacked title' }), ErrorCode.Forbidden);
    const shop = await u.seller.services.marketplace.mySellerProfile(c.A!);
    await owner.setSellerStatus(shop!.id, 'suspended');
    assert.deepEqual((await u.buyer.services.marketplace.search({ communityId: c.A! })).items, [], 'a suspended seller disappears');
    await rejects(u.seller.services.marketplace.setSellerStatus(shop!.id, 'active'), ErrorCode.Forbidden);
    await owner.setSellerStatus(shop!.id, 'active');
    const removed = await owner.moderateRemove(laptop, 'Stolen goods reported');
    assert.equal(removed.status, 'removed');
    await rejects(u.seller.services.marketplace.setListingStatus(laptop, 'active'), ErrorCode.Forbidden);
  });
});

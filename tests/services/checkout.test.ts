// Checkout and orders (Stage D, migration 34) against the real local
// Supabase: server pricing (delivery fee, GCT), the expected-total check,
// idempotency, reservations under concurrency (no overselling), per-seller
// orders and their privacy, and cancellation releasing stock.
//
//   A: owner (Owner), seller (Member, GCT-registered, delivers), seller2 (Member), buyer, buyer2 (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'seller' | 'seller2' | 'buyer' | 'buyer2', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'seller', 'seller2', 'buyer', 'buyer2');
  c.A = await community(u.owner, 'CheckoutA');
  for (const x of [u.seller, u.seller2, u.buyer, u.buyer2]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('product');
  const electronics = cats.find((x) => x.slug === 'electronics')!.id;
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Seller One' });
  id.shop = shop.id;
  await admin.from('seller_profiles').update({ gct_registered: true }).eq('id', shop.id);
  await u.seller.services.orders.saveDeliveryOption({ sellerProfileId: shop.id, communityId: c.A!, feeMinor: 50_000, parishes: ['Kingston'], estimatedDaysMin: 1, estimatedDaysMax: 2, active: true });
  const radio = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: electronics, title: 'Radio', condition: 'good', priceMinor: 500_000, fulfillment: ['pickup', 'seller_delivery'], publish: true });
  id.radio = radio.id;
  await u.seller.services.marketplace.setStock(radio.id, 3);
  const shop2 = await u.seller2.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Seller Two' });
  id.shop2 = shop2.id;
  const last = await u.seller2.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: electronics, title: 'Last one', condition: 'new', priceMinor: 100_000, fulfillment: ['pickup'], publish: true });
  id.last = last.id;
  await u.seller2.services.marketplace.setStock(last.id, 1);
});
after(() => cleanupCommunityContent(Object.values(c)));

test('preview prices delivery and GCT on the server; create checks the total and is idempotent', async () => {
  const o = u.buyer.services.orders;
  await u.buyer.services.cart.setQuantity(id.radio!, 2);
  const address = await o.saveAddress({ recipientName: 'Buyer', phone: '876 555 0101', line1: '1 Hope Rd', town: 'Kingston', parish: 'Kingston', isDefault: true });
  const choices = [{ sellerProfileId: id.shop!, method: 'seller_delivery' as const }];
  const preview = await o.preview(c.A!, choices, address.id);
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.subtotalMinor, 1_000_000);
  assert.equal(preview.deliveryMinor, 50_000);
  assert.equal(preview.taxMinor, 150_000);
  assert.equal(preview.totalMinor, 1_200_000);
  const requestId = o.newRequestId();
  const input = { communityId: c.A!, clientRequestId: requestId, choices, addressId: address.id, contactName: 'Buyer', contactPhone: '876 555 0101' };
  await rejects(o.create({ ...input, expectedTotalMinor: 1 }), ErrorCode.Validation);
  const checkoutId = await o.create({ ...input, expectedTotalMinor: preview.totalMinor });
  assert.equal(await o.create({ ...input, expectedTotalMinor: preview.totalMinor }), checkoutId, 'retry returns the same checkout');
  const { checkout, orders } = await o.checkout(checkoutId);
  assert.equal(checkout.status, 'awaiting_payment');
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.status, 'pending_payment');
  assert.equal((orders[0]!.address_snapshot as { parish: string }).parish, 'Kingston');
  id.checkout = checkoutId;
  id.order = orders[0]!.id;
  assert.equal((await u.buyer.services.cart.quote(c.A!)).lines.length, 0, 'bought lines leave the cart');
});

test('the seller sees the order only once it is paid; nobody else does', async () => {
  await rejects(u.seller.services.orders.order(id.order!), ErrorCode.NotFound);
  await admin.from('checkouts').update({ paid_at: new Date().toISOString() }).eq('id', id.checkout!);
  const forSeller = await u.seller.services.orders.order(id.order!);
  assert.equal(forSeller.role, 'seller');
  assert.equal(forSeller.items[0]!.unit_price_minor, 500_000);
  await rejects(u.seller2.services.orders.order(id.order!), ErrorCode.NotFound);
  await rejects(u.buyer2.services.orders.order(id.order!), ErrorCode.NotFound);
  await rejects(u.seller.services.orders.checkout(id.checkout!), ErrorCode.NotFound);
  assert.deepEqual(await u.seller.services.orders.addresses(), [], "a seller never sees the buyer's address book");
  await admin.from('checkouts').update({ paid_at: null }).eq('id', id.checkout!);
});

test('two buyers racing for the last item: exactly one checkout succeeds', async () => {
  for (const b of [u.buyer, u.buyer2]) await b.services.cart.setQuantity(id.last!, 1);
  const attempt = async (b: TestUser) => {
    const o = b.services.orders;
    const choices = [{ sellerProfileId: id.shop2!, method: 'pickup' as const }];
    const preview = await o.preview(c.A!, choices);
    return o.create({ communityId: c.A!, clientRequestId: o.newRequestId(), choices, contactName: 'B', contactPhone: '876 555 0102', expectedTotalMinor: preview.totalMinor });
  };
  const results = await Promise.allSettled([attempt(u.buyer), attempt(u.buyer2)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const { data } = await admin.from('inventory').select('on_hand, reserved').eq('listing_id', id.last!).single();
  assert.deepEqual(data, { on_hand: 1, reserved: 1 });
});

test('cancelling before payment releases the stock', async () => {
  await u.buyer.services.orders.cancelCheckout(id.checkout!);
  const { data } = await admin.from('inventory').select('reserved').eq('listing_id', id.radio!).single();
  assert.equal(data!.reserved, 0);
  assert.equal((await u.buyer.services.orders.order(id.order!)).order.status, 'cancelled');
  await rejects(u.buyer.services.orders.cancelCheckout(id.checkout!), ErrorCode.Validation);
});

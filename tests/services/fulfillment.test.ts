// Seller fulfillment, pickup and delivery (Stages G-H, migration 36) end to
// end: orders are paid through the payments handlers with the TEST provider,
// then moved by the seller and the buyer through the services.
//
//   A: owner (Owner), seller, seller2, buyer (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';
import { paymentHarness } from './paymentHarness.ts';

let u: Record<'owner' | 'seller' | 'seller2' | 'buyer', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const h = paymentHarness();

before(async () => {
  u = await users('owner', 'seller', 'seller2', 'buyer');
  c.A = await community(u.owner, 'FulfilA');
  for (const x of [u.seller, u.seller2, u.buyer]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('product');
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Fulfil Shop' });
  id.shop = shop.id;
  await u.seller.services.orders.saveDeliveryOption({ sellerProfileId: shop.id, communityId: c.A!, feeMinor: 30_000, parishes: [], active: true });
  const kettle = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: cats[0]!.id, title: 'Kettle', condition: 'new', priceMinor: 300_000, fulfillment: ['pickup', 'seller_delivery'], publish: true });
  id.kettle = kettle.id;
  await u.seller.services.marketplace.setStock(kettle.id, 10);
  id.address = (await u.buyer.services.orders.saveAddress({ recipientName: 'Buyer', phone: '876 555 0110', line1: '3 Main St', town: 'Mandeville', parish: 'Manchester', isDefault: true })).id;
});
after(() => cleanupCommunityContent(Object.values(c)));

async function paidOrder(method: 'pickup' | 'seller_delivery'): Promise<string> {
  const o = u.buyer.services.orders;
  await u.buyer.services.cart.setQuantity(id.kettle!, 1);
  const choices = [{ sellerProfileId: id.shop!, method }];
  const addressId = method === 'seller_delivery' ? id.address! : null;
  const preview = await o.preview(c.A!, choices, addressId);
  const checkoutId = await o.create({ communityId: c.A!, clientRequestId: o.newRequestId(), choices, addressId, contactName: 'Buyer', contactPhone: '876 555 0110', expectedTotalMinor: preview.totalMinor });
  const s = await h.session(u.buyer, checkoutId);
  await h.pay(s.body.redirectUrl!, 'succeeded');
  return (await o.checkout(checkoutId)).orders[0]!.id;
}

const stock = async () => (await admin.from('inventory').select('on_hand').eq('listing_id', id.kettle!).single()).data!.on_hand;

test('pickup: accept, prepare, ready; the buyer shows the code; the seller completes with it', async () => {
  const orderId = await paidOrder('pickup');
  const so = u.seller.services.orders;
  await rejects(u.seller2.services.orders.accept(orderId), ErrorCode.NotFound);
  await rejects(u.buyer.services.orders.accept(orderId), ErrorCode.NotFound);
  await so.accept(orderId);
  await so.startProcessing(orderId);
  await so.readyForPickup(orderId, 'Collect at the shop, 9-5');
  const forBuyer = await u.buyer.services.orders.order(orderId);
  assert.match(forBuyer.pickupCode!, /^\d{6}$/);
  assert.equal((await so.order(orderId)).pickupCode, null, 'the seller never receives the code');
  const wrong = forBuyer.pickupCode === '000000' ? '111111' : '000000';
  assert.equal(await so.confirmPickup(orderId, wrong), 'wrong_code');
  await rejects(so.confirmPickup(orderId, '12'), ErrorCode.Validation, 'code');
  assert.equal(await so.confirmPickup(orderId, forBuyer.pickupCode!), 'completed');
  const done = await u.buyer.services.orders.order(orderId);
  assert.equal(done.order.status, 'completed');
  assert.equal(done.pickupCode, null, 'a used code is no longer shown');
  assert.deepEqual(done.events.map((e) => e.to_status), ['pending_payment', 'paid', 'accepted', 'processing', 'ready_for_pickup', 'completed']);
});

test('delivery: the seller records the courier; the buyer confirms receipt', async () => {
  const orderId = await paidOrder('seller_delivery');
  const so = u.seller.services.orders;
  await so.accept(orderId);
  await rejects(so.dispatch(orderId, { trackingUrl: 'http://x.example/1' }), ErrorCode.Validation, 'trackingUrl');
  await so.dispatch(orderId, { courierName: 'Knutsford Express', trackingReference: 'KX9' });
  await so.markDeliveryFailed(orderId, 'Gate locked');
  await so.dispatch(orderId, { courierName: 'Knutsford Express', trackingReference: 'KX10', trackingUrl: 'https://track.example/KX10' });
  await so.markDelivered(orderId);
  const d = await u.buyer.services.orders.order(orderId);
  assert.equal(d.order.status, 'delivered');
  assert.equal(d.shipment!.tracking_reference, 'KX10');
  assert.equal(d.shipment!.attempts, 2);
  await rejects(u.seller.services.orders.confirmReceived(orderId), ErrorCode.NotFound);
  await u.buyer.services.orders.confirmReceived(orderId);
  assert.equal((await u.buyer.services.orders.order(orderId)).order.status, 'completed');
});

test('a rejection returns the stock and records one full refund; the buyer may cancel before acceptance', async () => {
  const before = await stock();
  const orderId = await paidOrder('pickup');
  assert.equal(await stock(), before - 1);
  await rejects(u.seller.services.orders.reject(orderId, 'no'), ErrorCode.Validation, 'reason');
  await u.seller.services.orders.reject(orderId, 'Out of this colour');
  assert.equal(await stock(), before);
  const { data: refunds } = await u.buyer.client.from('refunds').select('status, amount_minor, kind').eq('order_id', orderId);
  assert.deepEqual(refunds, [{ status: 'approved', amount_minor: 300_000, kind: 'automatic' }]);
  await rejects(u.seller.services.orders.sellerCancel(orderId, 'again please'), ErrorCode.Validation);

  const second = await paidOrder('pickup');
  await u.buyer.services.orders.buyerCancel(second, 'Ordered by mistake');
  assert.equal((await u.buyer.services.orders.order(second)).order.status, 'cancelled');
  const { data: sellerNote } = await admin.from('notifications').select('title').eq('user_id', u.seller.id).eq('title', 'Order cancelled by the buyer');
  assert.equal(sellerNote!.length, 1);
});

test('sales list: the seller sees paid orders only', async () => {
  const page = await u.seller.services.orders.sellerOrders({ communityId: c.A! });
  assert.ok(page.items.length >= 4);
  assert.ok(page.items.every((o) => o.status !== 'pending_payment'));
  assert.deepEqual((await u.seller2.services.orders.sellerOrders({ communityId: c.A! })).items, []);
});

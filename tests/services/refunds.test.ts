// Refunds and disputes (Stage I, migration 37) end to end with the TEST
// payment provider: requests, partial approval, processing through the
// adapter (only the provider's 'succeeded' completes a refund), the ledger,
// provider failures, disputes decided by a community manager, and privacy.
//
//   A: owner (Owner: marketplace.manage), seller, buyer, other (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';
import { ledgerSum, paidOrder, paymentHarness } from './paymentHarness.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const h = paymentHarness();

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'other');
  c.A = await community(u.owner, 'RefundsA');
  for (const x of [u.seller, u.buyer, u.other]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('product');
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Refund Shop' });
  id.shop = shop.id;
  const fan = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: cats[0]!.id, title: 'Fan', condition: 'new', priceMinor: 400_000, fulfillment: ['pickup'], publish: true });
  id.fan = fan.id;
  await u.seller.services.marketplace.setStock(fan.id, 20);
});
after(() => cleanupCommunityContent(Object.values(c)));

const payable = async () => {
  const { data } = await admin.from('ledger_entries').select('amount_minor, ledger_accounts!inner(kind, owner_user_id, community_id)')
    .eq('ledger_accounts.kind', 'seller_payable').eq('ledger_accounts.owner_user_id', u.seller.id).eq('ledger_accounts.community_id', c.A!);
  return -(data ?? []).reduce((s, r) => s + Number(r.amount_minor), 0);
};

test('a partial refund: requested, approved for less, completed only by the provider', async () => {
  const orderId = await paidOrder(h, u.buyer, c.A!, id.fan!, id.shop!, 2);
  await u.seller.services.orders.accept(orderId);
  const r = u.buyer.services.refunds;
  await rejects(r.request(orderId, 'too short'), ErrorCode.Validation, 'reason');
  await rejects(r.request(orderId, 'One fan arrived broken', 900_000), ErrorCode.Validation);
  const refundId = await r.request(orderId, 'One fan arrived broken', 400_000);
  await rejects(r.request(orderId, 'Another request at once'), ErrorCode.Validation);
  await rejects(u.buyer.services.refunds.decide(refundId, true), ErrorCode.NotFound);
  await rejects(u.seller.services.refunds.decide(refundId, true, { amountMinor: 500_000 }), ErrorCode.Validation);
  const before = await payable();
  await u.seller.services.refunds.decide(refundId, true, { amountMinor: 300_000, note: 'Partial: the fan works with a new blade' });
  let [refund] = await r.forOrder(orderId);
  assert.equal(refund!.status, 'approved');
  assert.equal(Number(refund!.amount_minor), 300_000);
  assert.equal(await payable(), before, 'approval moves no money');

  const processed = await h.refunds();
  assert.equal(processed.status, 200);
  assert.ok(processed.body.outcomes!.succeeded! >= 1);
  [refund] = await r.forOrder(orderId);
  assert.equal(refund!.status, 'succeeded');
  assert.ok(refund!.provider_refund_reference);
  assert.equal(await payable(), before - 300_000, "the refund comes out of the seller's balance");
  assert.equal(await ledgerSum(c.A!), 0);
  const { data: checkout } = await u.buyer.client.from('checkouts').select('status').eq('id', (await u.buyer.services.orders.order(orderId)).order.checkout_id).single();
  assert.equal(checkout!.status, 'partially_refunded');
  const { data: n } = await admin.from('notifications').select('title').eq('user_id', u.buyer.id).eq('type', 'refund');
  assert.ok(n!.some((x) => x.title === 'Refund completed'));
  assert.equal((await h.refunds()).body.outcomes!.succeeded ?? 0, 0, 'a completed refund is never sent twice');
});

test('a provider failure marks the refund failed; it is never shown as refunded', async () => {
  const orderId = await paidOrder(h, u.buyer, c.A!, id.fan!, id.shop!);
  await u.seller.services.orders.reject(orderId, 'Cannot supply this one');
  const { data: payment } = await admin.from('payments').select('provider_reference').eq('checkout_id', (await u.buyer.services.orders.order(orderId)).order.checkout_id).eq('status', 'succeeded').single();
  await admin.from('test_provider_sessions').update({ status: 'failed' }).eq('reference', payment!.provider_reference!);
  await h.refunds();
  const [refund] = await u.buyer.services.refunds.forOrder(orderId);
  assert.equal(refund!.status, 'failed');
  assert.equal(refund!.failure_code, 'not_captured');
  const { count } = await admin.from('audit_logs').select('*', { count: 'exact', head: true }).eq('action', 'refund.failed').eq('entity_id', refund!.id);
  assert.equal(count, 1);
  assert.equal(await ledgerSum(c.A!), 0);
});

test('a declined request goes to a dispute; a community manager decides it with a refund', async () => {
  const orderId = await paidOrder(h, u.buyer, c.A!, id.fan!, id.shop!);
  await u.seller.services.orders.accept(orderId);
  const refundId = await u.buyer.services.refunds.request(orderId, 'Not as described in the listing');
  await rejects(u.seller.services.refunds.decide(refundId, false, { note: '' }), ErrorCode.Validation);
  await u.seller.services.refunds.decide(refundId, false, { note: 'It matches the photos' });
  const disputeId = await u.buyer.services.refunds.openDispute(orderId, 'The colour is different from the photos');
  await rejects(u.buyer.services.refunds.openDispute(orderId, 'A second dispute on the same order'), ErrorCode.Validation);
  const { data: mgr } = await admin.from('notifications').select('title').eq('user_id', u.owner.id).eq('type', 'dispute');
  assert.equal(mgr!.length, 1, 'the community manager is told');
  await u.seller.services.refunds.addMessage(disputeId, 'Photos were taken in daylight');
  await rejects(u.other.services.refunds.dispute(disputeId), ErrorCode.NotFound);
  await rejects(u.seller.services.refunds.resolve(disputeId, { refund: false, note: 'mine' }), ErrorCode.NotFound);
  const forManager = await u.owner.services.refunds.disputes(c.A!);
  assert.ok(forManager.some((d) => d.id === disputeId));
  await u.owner.services.refunds.resolve(disputeId, { refund: true, amountMinor: 200_000, note: 'Half refund: colour differs' });
  const { dispute, messages } = await u.buyer.services.refunds.dispute(disputeId);
  assert.equal(dispute.status, 'resolved_refund');
  assert.equal(messages.length, 1);
  await rejects(u.buyer.services.refunds.addMessage(disputeId, 'more'), ErrorCode.Validation);
  await h.refunds();
  const refunds = await u.buyer.services.refunds.forOrder(orderId);
  assert.deepEqual(refunds.map((r) => [r.kind, r.status, Number(r.amount_minor)]), [['customer', 'rejected', 400_000], ['dispute', 'succeeded', 200_000]]);
  assert.equal(await ledgerSum(c.A!), 0);
});

test('refund processing and settings are guarded', async () => {
  assert.equal((await h.refunds('wrong')).status, 401);
  const { error } = await u.buyer.client.rpc('refunds_claim', { p_limit: 5 });
  assert.ok(error, 'users cannot claim refunds');
  const { error: e2 } = await u.seller.client.rpc('refund_apply_result', { p_refund_id: id.fan!, p_status: 'succeeded', p_provider_reference: 'x', p_failure_code: '' });
  assert.ok(e2, 'nor report a provider result');
  await rejects(u.seller.services.refunds.savePolicy(c.A!, { requestsEnabled: false, requestWindowDays: 7 }), ErrorCode.Forbidden);
  await u.owner.services.refunds.savePolicy(c.A!, { requestsEnabled: false, requestWindowDays: 7, policyText: 'Ask the seller first.' });
  assert.equal((await u.buyer.services.refunds.policy(c.A!))!.policy_text, 'Ask the seller first.');
  const orderId = await paidOrder(h, u.buyer, c.A!, id.fan!, id.shop!);
  await u.seller.services.orders.accept(orderId);
  await rejects(u.buyer.services.refunds.request(orderId, 'Requests are switched off here'), ErrorCode.Validation);
});

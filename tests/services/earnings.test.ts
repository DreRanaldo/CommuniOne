// Seller balances, statements and payout records (Stage K, migration 39):
// figures come only from the ledger; payouts are operator records of money
// sent outside the app, never more than the balance.
//
//   A: owner (Owner), seller, buyer, other (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, cleanupCommunityContent, community, users, type TestUser } from './setup.ts';
import { ledgerSum, paidOrder, paymentHarness } from './paymentHarness.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const h = paymentHarness();

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'other');
  c.A = await community(u.owner, 'EarningsA');
  for (const x of [u.seller, u.buyer, u.other]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('product');
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Earn Shop' });
  id.shop = shop.id;
  const mug = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: cats[0]!.id, title: 'Mug', condition: 'new', priceMinor: 150_000, fulfillment: ['pickup'], publish: true });
  id.mug = mug.id;
  await u.seller.services.marketplace.setStock(mug.id, 10);
});
after(() => cleanupCommunityContent(Object.values(c)));

test('the balance follows payments, completed refunds and recorded payouts', async () => {
  const e = u.seller.services.earnings;
  assert.equal((await e.balance(c.A!)).balanceMinor, 0);
  const first = await paidOrder(h, u.buyer, c.A!, id.mug!, id.shop!, 2);
  await paidOrder(h, u.buyer, c.A!, id.mug!, id.shop!, 1);
  assert.deepEqual(await e.balance(c.A!), { currency: 'JMD', earnedMinor: 450_000, refundedMinor: 0, paidOutMinor: 0, balanceMinor: 450_000 });

  await u.seller.services.orders.accept(first);
  const refundId = await u.buyer.services.refunds.request(first, 'One mug was chipped', 150_000);
  await u.seller.services.refunds.decide(refundId, true);
  assert.equal((await e.balance(c.A!)).refundedMinor, 0, 'an approved refund is not yet a refund');
  await h.refunds();
  assert.deepEqual(await e.balance(c.A!), { currency: 'JMD', earnedMinor: 450_000, refundedMinor: 150_000, paidOutMinor: 0, balanceMinor: 300_000 });

  const tooMuch = await admin.rpc('payout_record', { p_community_id: c.A!, p_seller_user_id: u.seller.id, p_amount_minor: 300_001, p_method: 'bank_transfer', p_external_reference: 'NCB-001', p_recorded_by: 'ops@test' });
  assert.ok(tooMuch.error, 'never more than the balance');
  const ok = await admin.rpc('payout_record', { p_community_id: c.A!, p_seller_user_id: u.seller.id, p_amount_minor: 200_000, p_method: 'bank_transfer', p_external_reference: 'NCB-002', p_recorded_by: 'ops@test' });
  assert.equal(ok.error, null);
  assert.deepEqual(await e.balance(c.A!), { currency: 'JMD', earnedMinor: 450_000, refundedMinor: 150_000, paidOutMinor: 200_000, balanceMinor: 100_000 });
  assert.equal(await ledgerSum(c.A!), 0);

  const lines = await e.statement(c.A!);
  assert.deepEqual(lines.map((l) => [l.kind, l.amountMinor]), [['payout', -200_000], ['refund', -150_000], ['payment_captured', 150_000], ['payment_captured', 300_000]]);
  const payouts = await e.payouts(c.A!);
  assert.equal(payouts[0]!.externalReference, 'NCB-002');
});

test('balances, statements and payouts are private, and payouts are operator-only', async () => {
  assert.equal((await u.other.services.earnings.balance(c.A!)).balanceMinor, 0);
  assert.deepEqual(await u.other.services.earnings.statement(c.A!), []);
  assert.deepEqual(await u.other.services.earnings.payouts(c.A!), []);
  const { error } = await u.owner.client.rpc('payout_record', { p_community_id: c.A!, p_seller_user_id: u.owner.id, p_amount_minor: 1, p_method: 'other', p_external_reference: 'self', p_recorded_by: 'me' });
  assert.ok(error, 'not even a community owner can record a payout');
  const { error: e2 } = await u.owner.client.rpc('ledger_summary', { p_community_id: c.A! });
  assert.ok(e2, 'the ledger summary is for operators');
  const summary = await admin.rpc('ledger_summary', { p_community_id: c.A! });
  assert.equal((summary.data ?? []).reduce((s: number, r: { balance_minor: number }) => s + Number(r.balance_minor), 0), 0);
});

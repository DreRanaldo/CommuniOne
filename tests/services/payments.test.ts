// Payments (Stages E-F, migration 35) end to end against the local stack:
// the Edge Function handlers with the TEST provider (no money moves),
// signed webhooks (valid, forged, stale, replayed), decline and retry,
// amount mismatch, reconciliation of a lost webhook, a late payment after
// the reservation ended (automatic refund), the ledger staying balanced,
// and payment privacy.
//
//   A: owner (Owner), seller (Member), buyer, other (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { signTestEvent } from '../../supabase/functions/_shared/payments/testProvider.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';
import { ledgerSum, paymentHarness, placeOrder, TEST_SECRET } from './paymentHarness.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const h = paymentHarness();

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'other');
  c.A = await community(u.owner, 'PaymentsA');
  for (const x of [u.seller, u.buyer, u.other]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('product');
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Pay Shop' });
  id.shop = shop.id;
  const lamp = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'product', categoryId: cats[0]!.id, title: 'Lamp', condition: 'new', priceMinor: 250_000, fulfillment: ['pickup'], publish: true });
  id.lamp = lamp.id;
  await u.seller.services.marketplace.setStock(lamp.id, 10);
});
after(() => cleanupCommunityContent(Object.values(c)));

const stock = async () => (await admin.from('inventory').select('on_hand, reserved').eq('listing_id', id.lamp!).single()).data!;

test('a session needs the signed-in buyer; the amount comes from the database', async () => {
  const checkoutId = await placeOrder(u.buyer, c.A!, id.lamp!, id.shop!, 2);
  id.checkout = checkoutId;
  assert.equal((await h.session(null, checkoutId)).status, 401);
  assert.equal((await h.session(u.other, checkoutId)).status, 404, "someone else's checkout");
  assert.equal((await h.session(u.buyer, 'not-a-uuid')).status, 400);
  const first = await h.session(u.buyer, checkoutId);
  assert.equal(first.status, 200);
  assert.match(first.body.redirectUrl!, /payments-test-checkout\?ref=tp_[0-9a-f]{32}&sig=/);
  const again = await h.session(u.buyer, checkoutId);
  assert.equal(again.body.paymentId, first.body.paymentId, 'an open session is reused');
  id.redirect = first.body.redirectUrl!;
  id.payment = first.body.paymentId!;
  const { data } = await admin.from('test_provider_sessions').select('amount_minor').eq('payment_id', id.payment).single();
  assert.equal(Number(data!.amount_minor), 500_000);
});

test('the test checkout page is test-mode only and refuses tampered links', async () => {
  const page = await h.page(id.redirect!);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /TEST MODE/);
  assert.doesNotMatch(html, /card number|cvv/i, 'no card details are asked for');
  const tampered = await h.page(id.redirect!.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(32)));
  assert.equal(tampered.status, 404);
});

test('returning to the app proves nothing; the signed webhook marks the order paid', async () => {
  assert.equal((await u.buyer.services.payments.state(id.checkout!)).paid, false);
  const paid = await h.pay(id.redirect!, 'succeeded');
  assert.equal(paid.status, 303);
  assert.match(paid.location!, /^communione:\/\/payment-return\?checkout=/);
  assert.doesNotMatch(paid.location!, /succeeded|paid/, 'the redirect carries no status');
  assert.equal(paid.outcome?.outcome, 'applied');
  id.paidEvent = JSON.stringify(paid.delivered);

  const state = await u.buyer.services.payments.state(id.checkout!);
  assert.equal(state.paid, true);
  assert.equal(state.payment!.status, 'succeeded');
  const { order } = await u.buyer.services.orders.order((await u.buyer.services.orders.checkout(id.checkout!)).orders[0]!.id);
  assert.equal(order.status, 'paid');
  assert.deepEqual(await stock(), { on_hand: 8, reserved: 0 }, 'reserved stock is committed');
  assert.equal(await ledgerSum(c.A!), 0, 'the ledger balances');
  const { data: seller } = await admin.from('notifications').select('type, title').eq('user_id', u.seller.id).eq('type', 'order');
  assert.equal(seller!.length, 1);
});

test('replayed, forged and stale webhooks change nothing', async () => {
  const { body, signature } = JSON.parse(id.paidEvent!) as { body: string; signature: string };
  assert.deepEqual(await (await h.webhook(body, signature)).json(), { outcome: 'duplicate' });
  const forged = JSON.stringify({ ...JSON.parse(body), id: 'tev_forged', status: 'succeeded' });
  assert.equal((await h.webhook(forged, signature)).status, 401, 'signature over a different body');
  assert.equal((await h.webhook(forged, await signTestEvent('x'.repeat(64), forged))).status, 401, 'wrong secret');
  const stale = await signTestEvent(TEST_SECRET, forged, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await h.webhook(forged, stale)).status, 401, 'too old');
  assert.equal((await h.webhook(forged, '')).status, 401, 'unsigned');
  const { count } = await admin.from('webhook_events').select('*', { count: 'exact', head: true }).eq('provider_event_id', 'tev_forged');
  assert.equal(count, 0, 'nothing from a rejected request is stored');
  const { count: payments } = await admin.from('payments').select('*', { count: 'exact', head: true }).eq('checkout_id', id.checkout!);
  assert.equal(payments, 1);
  assert.equal((await h.session(u.buyer, id.checkout!)).status, 409, 'a paid checkout cannot be paid again');
});

test('a declined payment can be retried with a new attempt', async () => {
  const checkoutId = await placeOrder(u.buyer, c.A!, id.lamp!, id.shop!, 1);
  const first = await h.session(u.buyer, checkoutId);
  const declined = await h.pay(first.body.redirectUrl!, 'failed');
  assert.equal(declined.outcome?.outcome, 'applied');
  let state = await u.buyer.services.payments.state(checkoutId);
  assert.equal(state.checkoutStatus, 'payment_failed');
  assert.equal(state.payment!.status, 'failed');
  assert.equal((await stock()).reserved, 1, 'stock stays reserved for a retry');
  const retry = await h.session(u.buyer, checkoutId);
  assert.notEqual(retry.body.paymentId, first.body.paymentId);
  await h.pay(retry.body.redirectUrl!, 'succeeded');
  state = await u.buyer.services.payments.state(checkoutId);
  assert.equal(state.paid, true);
  const { data: n } = await admin.from('notifications').select('body').eq('user_id', u.buyer.id).eq('type', 'payment');
  assert.ok(n!.every((x) => !/\d{4}/.test(x.body)), 'payment notifications carry no payment data');
});

test('an amount that does not match is held for review, not accepted', async () => {
  const checkoutId = await placeOrder(u.buyer, c.A!, id.lamp!, id.shop!, 1);
  const s = await h.session(u.buyer, checkoutId);
  const ref = new URL(s.body.redirectUrl!).searchParams.get('ref')!;
  const body = JSON.stringify({ id: 'tev_mismatch_' + ref.slice(3, 15), reference: ref, status: 'succeeded', amount_minor: 1, currency: 'JMD', occurred_at: new Date().toISOString() });
  assert.deepEqual(await (await h.webhook(body, await signTestEvent(TEST_SECRET, body))).json(), { outcome: 'mismatch' });
  const state = await u.buyer.services.payments.state(checkoutId);
  assert.equal(state.paid, false);
  assert.equal(state.payment!.status, 'unknown');
  assert.equal(state.payment!.failureCode, 'amount_mismatch');
  const { count } = await admin.from('audit_logs').select('*', { count: 'exact', head: true }).eq('action', 'payment.mismatch').eq('entity_id', s.body.paymentId!);
  assert.equal(count, 1);
  await u.buyer.services.orders.cancelCheckout(checkoutId);
});

test('reconciliation recovers a lost webhook; it needs the service-role key', async () => {
  const checkoutId = await placeOrder(u.buyer, c.A!, id.lamp!, id.shop!, 1);
  const s = await h.session(u.buyer, checkoutId);
  const ref = new URL(s.body.redirectUrl!).searchParams.get('ref')!;
  // The customer paid, but the webhook never arrived.
  await admin.from('test_provider_sessions').update({ status: 'succeeded' }).eq('reference', ref);
  assert.equal((await h.reconcile('wrong')).status, 401);
  const res = await h.reconcile();
  assert.equal(res.status, 200);
  assert.ok(((await res.json()) as { outcomes: Record<string, number> }).outcomes.applied! >= 1);
  assert.equal((await u.buyer.services.payments.state(checkoutId)).paid, true);
  assert.equal(await ledgerSum(c.A!), 0);
});

test('a payment that arrives after the reservation ended is refunded automatically when stock ran out', async () => {
  const checkoutId = await placeOrder(u.buyer, c.A!, id.lamp!, id.shop!, 1);
  const s = await h.session(u.buyer, checkoutId);
  await admin.from('checkouts').update({ reservation_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', checkoutId);
  await admin.rpc('expire_checkouts');
  assert.equal((await u.buyer.services.payments.state(checkoutId)).checkoutStatus, 'expired');
  await u.seller.services.marketplace.setStock(id.lamp!, 0);
  const late = await h.pay(s.body.redirectUrl!, 'succeeded');
  assert.equal(late.outcome?.outcome, 'applied');
  const { orders } = await u.buyer.services.orders.checkout(checkoutId);
  assert.equal(orders[0]!.status, 'cancelled');
  const { data: refunds } = await u.buyer.client.from('refunds').select('kind, status, amount_minor').eq('payment_id', s.body.paymentId!);
  assert.equal(refunds!.length, 1);
  assert.equal(refunds![0]!.kind, 'automatic');
  assert.equal(Number(refunds![0]!.amount_minor), 250_000);
  assert.equal(await ledgerSum(c.A!), 0);
  await u.seller.services.marketplace.setStock(id.lamp!, 10);
});

test('unknown references are recorded but change nothing', async () => {
  const body = JSON.stringify({ id: 'tev_unknown_ref_1', reference: 'tp_' + 'f'.repeat(32), status: 'succeeded', amount_minor: 1, currency: 'JMD', occurred_at: new Date().toISOString() });
  assert.deepEqual(await (await h.webhook(body, await signTestEvent(TEST_SECRET, body))).json(), { outcome: 'unknown_payment' });
});

test('payments are private: no provider references, no one else sees them', async () => {
  const { data: mine, error } = await u.buyer.client.from('payments').select('id, status').eq('checkout_id', id.checkout!);
  assert.equal(error, null);
  assert.equal(mine!.length, 1);
  const { error: refErr } = await u.buyer.client.from('payments').select('provider_reference');
  assert.ok(refErr, 'provider_reference is not readable by clients');
  const { data: theirs } = await u.other.client.from('payments').select('id');
  assert.deepEqual(theirs, []);
  for (const table of ['payment_events', 'webhook_events', 'ledger_entries', 'ledger_accounts', 'test_provider_sessions'] as const) {
    const { data } = await u.buyer.client.from(table).select('*');
    assert.ok(!data || data.length === 0, `${table} is server-only`);
  }
  const { error: ins } = await u.buyer.client.from('payments').insert({ community_id: c.A!, checkout_id: id.checkout!, provider: 'test', mode: 'test', amount_minor: 1, currency: 'JMD' } as never);
  assert.ok(ins, 'clients cannot create payments');
  await rejects(u.other.services.payments.state(id.checkout!), ErrorCode.NotFound);
});

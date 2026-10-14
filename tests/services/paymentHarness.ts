// Drives the payments Edge Function handlers in Node against the local
// stack, with the TEST provider (PAYMENTS_MODE=test). The Deno entry points
// in supabase/functions/* call exactly these handlers.
import { randomBytes } from 'node:crypto';
import {
  handleReconcile,
  handleRefunds,
  handleSession,
  handleTestCheckout,
  handleWebhook,
  type PaymentsContext,
} from '../../supabase/functions/_shared/payments/handlers.ts';
import { createTestProvider, TEST_SIGNATURE_HEADER } from '../../supabase/functions/_shared/payments/testProvider.ts';
import { admin } from './setup.ts';
import type { TestUser } from './setup.ts';

export const TEST_SECRET = randomBytes(32).toString('hex');
const PAGE = 'http://localhost/functions/v1/payments-test-checkout';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export function paymentHarness(now?: () => number) {
  const provider = createTestProvider({ secret: TEST_SECRET, db: admin, checkoutPageUrl: PAGE, now });
  const ctx: PaymentsContext & { provider: typeof provider } = {
    db: admin,
    provider,
    serviceRoleKey,
    returnUrl: 'communione://payment-return',
    async resolveUser(authorization) {
      const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!token) return null;
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
  };
  const webhook = (body: string, signature: string) =>
    handleWebhook(ctx, new Request('http://localhost/functions/v1/payments-webhook', { method: 'POST', body, headers: { [TEST_SIGNATURE_HEADER]: signature } }));

  return {
    ctx,
    provider,
    webhook,
    async token(u: TestUser) {
      return (await u.client.auth.getSession()).data.session!.access_token;
    },
    async session(u: TestUser | null, checkoutId: string) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (u) headers.authorization = `Bearer ${await this.token(u)}`;
      const res = await handleSession(ctx, new Request('http://localhost/functions/v1/payments-session', { method: 'POST', headers, body: JSON.stringify({ checkoutId }) }));
      return { status: res.status, body: (await res.json()) as { paymentId?: string; redirectUrl?: string; expiresAt?: string; error?: string } };
    },
    async sessionBooking(u: TestUser, bookingId: string) {
      const res = await handleSession(ctx, new Request('http://localhost/functions/v1/payments-session', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.token(u)}` }, body: JSON.stringify({ bookingId }),
      }));
      return { status: res.status, body: (await res.json()) as { paymentId?: string; redirectUrl?: string; error?: string } };
    },
    /** The customer opens the hosted page and picks an outcome. */
    async pay(redirectUrl: string, outcome: 'succeeded' | 'failed' | 'cancelled') {
      const url = new URL(redirectUrl);
      let delivered: { body: string; signature: string } | null = null;
      let outcomeBody: unknown = null;
      const res = await handleTestCheckout(ctx, new Request(PAGE, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ref: url.searchParams.get('ref')!, sig: url.searchParams.get('sig')!, outcome }).toString(),
      }), async (body, signature) => {
        delivered = { body, signature };
        const r = await webhook(body, signature);
        outcomeBody = await r.clone().json();
        return r;
      });
      return { status: res.status, location: res.headers.get('location'), delivered: delivered as { body: string; signature: string } | null, outcome: outcomeBody as { outcome?: string } | null };
    },
    page(redirectUrl: string) {
      return handleTestCheckout(ctx, new Request(redirectUrl.replace(/^.*\?/, `${PAGE}?`)), () => Promise.reject(new Error('no webhook on GET')));
    },
    async refunds(bearer = serviceRoleKey) {
      const res = await handleRefunds(ctx, new Request('http://localhost/functions/v1/refunds-process', { method: 'POST', headers: { authorization: `Bearer ${bearer}` } }));
      return { status: res.status, body: (await res.json()) as { outcomes?: Record<string, number> } };
    },
    reconcile(bearer = serviceRoleKey) {
      return handleReconcile(ctx, new Request('http://localhost/functions/v1/payments-reconcile?age_seconds=0', { method: 'POST', headers: { authorization: `Bearer ${bearer}` } }));
    },
  };
}

/** Places and pays for an order (pickup) and returns its order id. */
export async function paidOrder(h: ReturnType<typeof paymentHarness>, buyer: TestUser, communityId: string, listingId: string, sellerProfileId: string, quantity = 1): Promise<string> {
  const checkoutId = await placeOrder(buyer, communityId, listingId, sellerProfileId, quantity);
  const s = await h.session(buyer, checkoutId);
  await h.pay(s.body.redirectUrl!, 'succeeded');
  return (await buyer.services.orders.checkout(checkoutId)).orders[0]!.id;
}

/** Puts a buyer's cart line through checkout and returns the checkout id. */
export async function placeOrder(buyer: TestUser, communityId: string, listingId: string, sellerProfileId: string, quantity = 1): Promise<string> {
  await buyer.services.cart.setQuantity(listingId, quantity);
  const o = buyer.services.orders;
  const choices = [{ sellerProfileId, method: 'pickup' as const }];
  const preview = await o.preview(communityId, choices);
  return o.create({ communityId, clientRequestId: o.newRequestId(), choices, contactName: 'Buyer', contactPhone: '876 555 0199', expectedTotalMinor: preview.totalMinor });
}

/** Sum of every ledger entry for a transaction set: must be zero. */
export async function ledgerSum(communityId: string): Promise<number> {
  const { data, error } = await admin.from('ledger_entries').select('amount_minor, ledger_transactions!inner(community_id)').eq('ledger_transactions.community_id', communityId);
  if (error) throw error;
  return (data ?? []).reduce((s, r) => s + Number(r.amount_minor), 0);
}

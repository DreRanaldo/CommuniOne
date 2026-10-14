// The TEST payment provider (Stage E). It behaves like a hosted-checkout
// provider so the whole flow (session, customer page, signed webhook,
// status queries, refunds) can be exercised end to end WITHOUT MONEY:
//   * sessions live in public.test_provider_sessions (service role only);
//   * the "hosted page" is the payments-test-checkout Edge Function;
//   * webhooks are signed: header x-test-signature = "t=<unix>,v1=<hex>",
//     v1 = HMAC-SHA256(PAYMENTS_TEST_SECRET, `${t}.${body}`), max 5 minutes old.
// It refuses to run unless PAYMENTS_MODE=test (assertSafeConfiguration).

import { hmacSha256Hex, randomToken, sha256Hex, timingSafeEqualHex } from './crypto.ts';
import {
  ProviderUnavailable,
  WebhookRejected,
  type PaymentProvider,
  type ProviderStatus,
  type RefundResult,
  type Session,
  type SessionInput,
  type VerifiedEvent,
} from './provider.ts';

/** The subset of a supabase-js client (service role) the test provider uses. */
export interface ServiceDb {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any;
}

export const TEST_SIGNATURE_HEADER = 'x-test-signature';
const MAX_AGE_SECONDS = 300;
const SESSION_MINUTES = 15;

export interface TestEventBody {
  id: string;
  reference: string;
  status: ProviderStatus;
  amount_minor: number;
  currency: string;
  occurred_at: string;
}

/** Signs a test webhook body (the test checkout page and tests use it). */
export async function signTestEvent(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${nowSeconds},v1=${await hmacSha256Hex(secret, `${nowSeconds}.${body}`)}`;
}

export function createTestProvider(options: { secret: string; db: ServiceDb; checkoutPageUrl: string; now?: () => number }): PaymentProvider & {
  /** The customer's choice on the test checkout page; returns the webhook to deliver. */
  complete(reference: string, outcome: 'succeeded' | 'failed' | 'cancelled'): Promise<{ body: string; signature: string; returnUrl: string }>;
  /** The signed link the checkout page accepts (prevents tampering with the reference). */
  pageSignature(reference: string): Promise<string>;
} {
  const { secret, db, checkoutPageUrl } = options;
  const now = options.now ?? (() => Date.now());
  if (!secret || secret.length < 32) throw new Error('PAYMENTS_TEST_SECRET must be at least 32 characters.');

  const session = async (reference: string) => {
    const { data, error } = await db.from('test_provider_sessions').select('*').eq('reference', reference).maybeSingle();
    if (error) throw new ProviderUnavailable(error.message);
    return data as { reference: string; payment_id: string; amount_minor: number; currency: string; status: string;
      refunded_minor: number; return_url: string; expires_at: string } | null;
  };

  const provider = {
    name: 'test',
    mode: 'test' as const,

    async createSession(input: SessionInput): Promise<Session> {
      const existing = await db.from('test_provider_sessions').select('*').eq('payment_id', input.paymentId).maybeSingle();
      if (existing.error) throw new ProviderUnavailable(existing.error.message);
      const row = existing.data ?? (await (async () => {
        const reference = `tp_${randomToken(16)}`;
        const { data, error } = await db.from('test_provider_sessions').insert({
          reference, payment_id: input.paymentId, amount_minor: input.amountMinor, currency: input.currency,
          return_url: input.returnUrl, expires_at: new Date(now() + SESSION_MINUTES * 60_000).toISOString(),
        }).select('*').single();
        if (error) throw new ProviderUnavailable(error.message);
        return data;
      })());
      const sig = await provider.pageSignature(row.reference);
      return {
        reference: row.reference,
        redirectUrl: `${checkoutPageUrl}?ref=${encodeURIComponent(row.reference)}&sig=${sig}`,
        expiresAt: row.expires_at,
      };
    },

    async fetchStatus(reference: string) {
      const row = await session(reference);
      if (!row) return { status: 'unknown' as const, amountMinor: null, currency: null };
      const expired = row.status === 'pending' && Date.parse(row.expires_at) <= now();
      return { status: (expired ? 'expired' : row.status) as ProviderStatus, amountMinor: Number(row.amount_minor), currency: row.currency };
    },

    async verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedEvent> {
      const header = headers.get(TEST_SIGNATURE_HEADER) ?? '';
      const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
      if (!match) throw new WebhookRejected('missing or malformed signature');
      const t = Number(match[1]);
      if (Math.abs(Math.floor(now() / 1000) - t) > MAX_AGE_SECONDS) throw new WebhookRejected('signature too old');
      const text = new TextDecoder().decode(rawBody);
      const expected = await hmacSha256Hex(secret, `${t}.${text}`);
      if (!timingSafeEqualHex(expected, match[2]!)) throw new WebhookRejected('bad signature');
      let body: TestEventBody;
      try {
        body = JSON.parse(text) as TestEventBody;
      } catch {
        throw new WebhookRejected('malformed body');
      }
      if (typeof body.id !== 'string' || typeof body.reference !== 'string' || typeof body.status !== 'string')
        throw new WebhookRejected('malformed body');
      return {
        eventId: body.id,
        reference: body.reference,
        status: body.status,
        amountMinor: typeof body.amount_minor === 'number' ? body.amount_minor : null,
        currency: typeof body.currency === 'string' ? body.currency : null,
        occurredAt: body.occurred_at,
        rawSha256: await sha256Hex(rawBody),
      };
    },

    async refund(input: { refundId: string; reference: string; amountMinor: number; currency: string }): Promise<RefundResult> {
      const row = await session(input.reference);
      if (!row || row.status !== 'succeeded') return { reference: `trf_${input.refundId}`, status: 'failed', failureCode: 'not_captured' };
      if (Number(row.refunded_minor) + input.amountMinor > Number(row.amount_minor))
        return { reference: `trf_${input.refundId}`, status: 'failed', failureCode: 'exceeds_captured' };
      const { error } = await db.from('test_provider_sessions')
        .update({ refunded_minor: Number(row.refunded_minor) + input.amountMinor, updated_at: new Date(now()).toISOString() })
        .eq('reference', input.reference);
      if (error) throw new ProviderUnavailable(error.message);
      return { reference: `trf_${input.refundId}`, status: 'succeeded' };
    },

    async pageSignature(reference: string) {
      return (await hmacSha256Hex(secret, `page.${reference}`)).slice(0, 32);
    },

    async complete(reference: string, outcome: 'succeeded' | 'failed' | 'cancelled') {
      const row = await session(reference);
      if (!row) throw new WebhookRejected('unknown session');
      if (row.status !== 'pending') throw new WebhookRejected('this test payment is already finished');
      if (Date.parse(row.expires_at) <= now()) throw new WebhookRejected('this test payment session expired');
      const { error } = await db.from('test_provider_sessions').update({ status: outcome, updated_at: new Date(now()).toISOString() }).eq('reference', reference);
      if (error) throw new ProviderUnavailable(error.message);
      const body = JSON.stringify({
        id: `tev_${randomToken(12)}`, reference, status: outcome, amount_minor: Number(row.amount_minor), currency: row.currency,
        occurred_at: new Date(now()).toISOString(),
      } satisfies TestEventBody);
      return { body, signature: await signTestEvent(secret, body, Math.floor(now() / 1000)), returnUrl: row.return_url };
    },
  };
  return provider;
}

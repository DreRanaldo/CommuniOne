// The provider-neutral payment adapter (docs/commerce/payments.md). Pure
// TypeScript on Web APIs only, so the same code runs in Supabase Edge
// Functions (Deno) and in the Node test suite. A real provider (PowerTranz,
// WiPay, ...) is added by implementing PaymentProvider; orders, refunds and
// the ledger do not change. NO real provider is implemented yet: credentials
// and merchant approval are pending (decisions D2-D3).

export type ProviderStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown';
export type PaymentMode = 'test' | 'sandbox' | 'live';

export interface SessionInput {
  /** Our payments.id: also the provider idempotency key. */
  paymentId: string;
  /** Integer minor units, read from the database (never from the app). */
  amountMinor: number;
  currency: string;
  /** No personal data. */
  description: string;
  /** Where the provider sends the customer back (the app's deep link). */
  returnUrl: string;
}

export interface Session {
  reference: string;
  redirectUrl: string;
  expiresAt: string;
}

/** A provider event whose signature (and freshness) has been verified. */
export interface VerifiedEvent {
  eventId: string;
  reference: string;
  status: ProviderStatus;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: string;
  /** SHA-256 of the raw body, kept instead of the payload. */
  rawSha256: string;
}

export interface ProviderPaymentStatus {
  status: ProviderStatus;
  amountMinor: number | null;
  currency: string | null;
}

export interface RefundResult {
  reference: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureCode?: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: PaymentMode;
  createSession(input: SessionInput): Promise<Session>;
  fetchStatus(reference: string): Promise<ProviderPaymentStatus>;
  /** Throws WebhookRejected unless the request is authentic and fresh. */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedEvent>;
  /** Full or partial refund; idempotent per refundId. */
  refund(input: { refundId: string; reference: string; amountMinor: number; currency: string }): Promise<RefundResult>;
}

export class WebhookRejected extends Error {}

/** A provider-side failure (network, timeout, 5xx): the caller retries later. */
export class ProviderUnavailable extends Error {}

/** Refuses configurations that would fake money movement. */
export function assertSafeConfiguration(provider: PaymentProvider, requestedMode: string | undefined): void {
  const mode = requestedMode ?? 'test';
  if (!['test', 'sandbox', 'live'].includes(mode)) throw new Error(`Unknown PAYMENTS_MODE "${mode}".`);
  if (provider.name === 'test' && mode !== 'test') {
    throw new Error('The test provider can only run with PAYMENTS_MODE=test. It must never handle real payments.');
  }
  if (provider.mode !== mode) throw new Error(`Provider "${provider.name}" is configured for ${provider.mode}, not ${mode}.`);
}

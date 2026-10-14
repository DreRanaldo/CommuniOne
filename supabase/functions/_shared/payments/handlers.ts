// HTTP handlers for the payments Edge Functions (Stage E). Each takes a
// Request and returns a Response, so the Deno entry points stay one-liners
// and the Node integration tests drive exactly the same code.
//
//   payments-session        POST {checkoutId} | {bookingId} (user JWT) -> {paymentId, redirectUrl, expiresAt}
//   payments-webhook        POST <provider body> (signature) -> 200 {outcome} | 401
//   payments-reconcile      POST                (service-role bearer, cron)
//   payments-test-checkout  GET page / POST choice (test provider only)
//
// Amounts always come from the database (payment_begin), never from the
// request. Webhooks are verified before anything is stored, and applied
// idempotently by payment_apply_event (one row per provider event id).

import { ProviderUnavailable, WebhookRejected, type PaymentProvider } from './provider.ts';
import type { ServiceDb } from './testProvider.ts';
import { timingSafeEqualHex } from './crypto.ts';

export interface PaymentsContext {
  /** supabase-js client created with the service-role key (server only). */
  db: ServiceDb;
  provider: PaymentProvider;
  /** Returns the verified user id for an `Authorization: Bearer <jwt>` header, or null. */
  resolveUser(authorization: string | null): Promise<string | null>;
  /** The app deep link the provider returns the customer to. */
  returnUrl: string;
  /** The service-role key, compared (constant time) for the reconcile endpoint. */
  serviceRoleKey: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps a PostgREST error to an HTTP status without leaking internals. */
function dbStatus(error: { code?: string }): number {
  if (error.code === 'P0002') return 404;
  if (error.code === '22023' || error.code === '23514') return 409;
  if (error.code === '42501') return 403;
  return 500;
}

// ---------------------------------------------------------------------------
// payments-session: the buyer starts paying for a checkout.
// ---------------------------------------------------------------------------
export async function handleSession(ctx: PaymentsContext, req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  const userId = await ctx.resolveUser(req.headers.get('authorization'));
  if (!userId) return json(401, { error: 'sign in required' });
  let body: { checkoutId?: unknown; bookingId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid body' });
  }
  // Exactly one of a checkout (products) or a booking (services).
  const checkoutId = body.checkoutId;
  const bookingId = body.bookingId;
  const forBooking = typeof bookingId === 'string' && checkoutId === undefined;
  const target = forBooking ? bookingId : checkoutId;
  if (typeof target !== 'string' || !UUID.test(target)) return json(400, { error: 'checkoutId or bookingId is required' });

  const begun = forBooking
    ? await ctx.db.rpc('payment_begin_booking', { p_user_id: userId, p_booking_id: target, p_provider: ctx.provider.name, p_mode: ctx.provider.mode })
    : await ctx.db.rpc('payment_begin', { p_user_id: userId, p_checkout_id: target, p_provider: ctx.provider.name, p_mode: ctx.provider.mode });
  if (begun.error) return json(dbStatus(begun.error), { error: dbStatus(begun.error) === 500 ? 'could not start the payment' : begun.error.message });
  const row = (begun.data as Array<{ payment_id: string; amount_minor: number; currency: string; provider_reference: string | null;
    redirect_url: string | null; session_expires_at: string | null; description: string }>)[0]!;
  if (row.provider_reference && row.redirect_url) {
    return json(200, { paymentId: row.payment_id, redirectUrl: row.redirect_url, expiresAt: row.session_expires_at, mode: ctx.provider.mode });
  }

  try {
    const session = await ctx.provider.createSession({
      paymentId: row.payment_id, amountMinor: Number(row.amount_minor), currency: row.currency, description: row.description,
      returnUrl: `${ctx.returnUrl}?${forBooking ? 'booking' : 'checkout'}=${target}`,
    });
    const attached = await ctx.db.rpc('payment_attach_session', {
      p_payment_id: row.payment_id, p_provider_reference: session.reference, p_redirect_url: session.redirectUrl,
      p_session_expires_at: session.expiresAt,
    });
    if (attached.error) return json(dbStatus(attached.error), { error: 'could not start the payment' });
    return json(200, { paymentId: row.payment_id, redirectUrl: session.redirectUrl, expiresAt: session.expiresAt, mode: ctx.provider.mode });
  } catch (error) {
    if (error instanceof ProviderUnavailable) return json(503, { error: 'the payment provider is unavailable; try again shortly' });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// payments-webhook: the provider reports a payment status.
// ---------------------------------------------------------------------------
export async function handleWebhook(ctx: PaymentsContext, req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > 64 * 1024) return json(413, { error: 'too large' });
  let event;
  try {
    event = await ctx.provider.verifyWebhook(raw, req.headers);
  } catch (error) {
    // Nothing from an unverified request is stored or acted on.
    if (error instanceof WebhookRejected) return json(401, { error: 'rejected' });
    throw error;
  }
  const { data, error } = await ctx.db.rpc('payment_apply_event', {
    p_provider: ctx.provider.name, p_provider_event_id: event.eventId, p_provider_reference: event.reference,
    p_status: event.status, p_amount_minor: event.amountMinor, p_currency: event.currency,
    p_occurred_at: event.occurredAt, p_raw_sha256: event.rawSha256, p_source: 'webhook',
  });
  // A 5xx makes the provider retry; the event id makes the retry safe.
  if (error) return json(dbStatus(error) === 500 ? 500 : 400, { error: 'not processed' });
  return json(200, { outcome: data });
}

// ---------------------------------------------------------------------------
// payments-reconcile: scheduled; asks the provider about open payments,
// expires unpaid checkouts (releasing their reservations), refunds paid
// orders nobody accepted in 48 hours and completes delivered orders after 7 days.
// ---------------------------------------------------------------------------
export async function handleReconcile(ctx: PaymentsContext, req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!ctx.serviceRoleKey || !timingSafeEqualHex(bearer, ctx.serviceRoleKey)) return json(401, { error: 'unauthorized' });
  const ageSeconds = Number(new URL(req.url).searchParams.get('age_seconds') ?? '300');
  const age = `${Number.isFinite(ageSeconds) && ageSeconds >= 0 ? Math.floor(ageSeconds) : 300} seconds`;

  const open = await ctx.db.rpc('payments_to_reconcile', { p_age: age });
  if (open.error) return json(500, { error: 'could not list payments' });
  const outcomes: Record<string, number> = {};
  for (const p of (open.data ?? []) as Array<{ payment_id: string; provider: string; provider_reference: string }>) {
    if (p.provider !== ctx.provider.name) continue;
    let status;
    try {
      status = await ctx.provider.fetchStatus(p.provider_reference);
    } catch (error) {
      if (error instanceof ProviderUnavailable) { outcomes.provider_unavailable = (outcomes.provider_unavailable ?? 0) + 1; continue; }
      throw error;
    }
    if (status.status === 'pending' || status.status === 'requires_action') { outcomes.still_open = (outcomes.still_open ?? 0) + 1; continue; }
    const applied = await ctx.db.rpc('payment_apply_event', {
      p_provider: ctx.provider.name, p_provider_event_id: null, p_provider_reference: p.provider_reference,
      p_status: status.status, p_amount_minor: status.amountMinor, p_currency: status.currency,
      p_occurred_at: new Date().toISOString(), p_raw_sha256: null, p_source: 'reconcile',
    });
    const key = applied.error ? 'error' : String(applied.data);
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const expired = await ctx.db.rpc('expire_checkouts');
  // Order housekeeping: unaccepted paid orders are refunded; delivered ones complete.
  const unaccepted = await ctx.db.rpc('expire_unaccepted_orders');
  const completed = await ctx.db.rpc('complete_delivered_orders');
  const expiredBookings = await ctx.db.rpc('expire_unpaid_bookings');
  const completedBookings = await ctx.db.rpc('complete_past_bookings');
  return json(200, {
    outcomes,
    expiredCheckouts: expired.error ? null : expired.data,
    unacceptedOrders: unaccepted.error ? null : unaccepted.data,
    completedOrders: completed.error ? null : completed.data,
    expiredBookings: expiredBookings.error ? null : expiredBookings.data,
    completedBookings: completedBookings.error ? null : completedBookings.data,
  });
}

// ---------------------------------------------------------------------------
// payments-test-checkout: the TEST provider's "hosted payment page". It only
// exists with PAYMENTS_MODE=test; no card details are asked for or accepted.
// ---------------------------------------------------------------------------
export interface TestCheckoutProvider extends PaymentProvider {
  complete(reference: string, outcome: 'succeeded' | 'failed' | 'cancelled'): Promise<{ body: string; signature: string; returnUrl: string }>;
  pageSignature(reference: string): Promise<string>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function handleTestCheckout(
  ctx: Omit<PaymentsContext, 'provider'> & { provider: TestCheckoutProvider },
  req: Request,
  deliverWebhook: (body: string, signature: string) => Promise<Response>,
): Promise<Response> {
  if (ctx.provider.name !== 'test' || ctx.provider.mode !== 'test') return json(404, { error: 'not found' });
  const url = new URL(req.url);
  let ref: string | null;
  let sig: string | null;
  let outcome: string | null = null;
  if (req.method === 'GET') {
    ref = url.searchParams.get('ref');
    sig = url.searchParams.get('sig');
  } else if (req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    ref = form.get('ref');
    sig = form.get('sig');
    outcome = form.get('outcome');
  } else {
    return json(405, { error: 'method not allowed' });
  }
  if (!ref || !sig || !/^tp_[0-9a-f]{32}$/.test(ref) || !timingSafeEqualHex(await ctx.provider.pageSignature(ref), sig)) {
    return new Response('Invalid test payment link.', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  if (req.method === 'GET') {
    const status = await ctx.provider.fetchStatus(ref);
    const amount = status.amountMinor === null ? '' : `${status.currency} ${(status.amountMinor / 100).toFixed(2)}`;
    const button = (value: string, label: string) =>
      `<button name="outcome" value="${value}" style="display:block;width:100%;margin:8px 0;padding:14px;font-size:16px">${label}</button>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test payment</title></head><body style="font-family:system-ui;max-width:420px;margin:24px auto;padding:0 16px">
<p style="background:#fde68a;padding:12px;border-radius:8px"><strong>TEST MODE.</strong> No real money moves and no card details are collected.</p>
<h1>Test payment</h1><p>Amount: <strong>${escapeHtml(amount)}</strong></p>
${status.status === 'pending'
  ? `<form method="post"><input type="hidden" name="ref" value="${escapeHtml(ref)}"><input type="hidden" name="sig" value="${escapeHtml(sig)}">
${button('succeeded', 'Simulate successful payment')}${button('failed', 'Simulate declined payment')}${button('cancelled', 'Cancel')}</form>`
  : `<p>This test payment is ${escapeHtml(status.status)}.</p>`}
</body></html>`;
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" },
    });
  }

  if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') return json(400, { error: 'invalid outcome' });
  let completed;
  try {
    completed = await ctx.provider.complete(ref, outcome);
  } catch (error) {
    if (error instanceof WebhookRejected) return new Response(error.message, { status: 409, headers: { 'content-type': 'text/plain' } });
    throw error;
  }
  // Like a real provider, the result reaches CommuniOne only through the
  // signed webhook; the redirect below carries no payment status.
  await deliverWebhook(completed.body, completed.signature).catch(() => undefined);
  return new Response(null, { status: 303, headers: { location: completed.returnUrl } });
}

// ---------------------------------------------------------------------------
// refunds-process: scheduled; sends approved refunds to the provider. A
// refund is completed only when the provider says 'succeeded'.
// ---------------------------------------------------------------------------
export async function handleRefunds(ctx: PaymentsContext, req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!ctx.serviceRoleKey || !timingSafeEqualHex(bearer, ctx.serviceRoleKey)) return json(401, { error: 'unauthorized' });
  const claimed = await ctx.db.rpc('refunds_claim', { p_limit: 20 });
  if (claimed.error) return json(500, { error: 'could not claim refunds' });
  const outcomes: Record<string, number> = {};
  for (const r of (claimed.data ?? []) as Array<{ refund_id: string; provider: string; provider_reference: string | null; amount_minor: number; currency: string }>) {
    let result: { status: string; reference: string | null; failureCode: string | null };
    if (r.provider !== ctx.provider.name || !r.provider_reference) {
      result = { status: 'failed', reference: null, failureCode: 'no_provider_for_payment' };
    } else {
      try {
        const answer = await ctx.provider.refund({ refundId: r.refund_id, reference: r.provider_reference, amountMinor: Number(r.amount_minor), currency: r.currency });
        result = { status: answer.status, reference: answer.reference, failureCode: answer.failureCode ?? null };
      } catch (error) {
        if (!(error instanceof ProviderUnavailable)) throw error;
        result = { status: 'retry', reference: null, failureCode: null };
      }
    }
    const applied = await ctx.db.rpc('refund_apply_result', {
      p_refund_id: r.refund_id, p_status: result.status, p_provider_reference: result.reference, p_failure_code: result.failureCode,
    });
    const key = applied.error ? 'error' : String(applied.data);
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return json(200, { outcomes });
}

// Paying for a checkout (Stage E). The app never sends an amount and never
// decides that an order is paid: it asks the payments-session Edge Function
// for a hosted payment page (the amount comes from the database), opens it,
// and then reads the status the SERVER recorded from the provider's signed
// webhook (or reconciliation). Returning from the payment page proves
// nothing on its own.
//
// Only the TEST provider exists today (PAYMENTS_MODE=test): no real money
// moves. A live provider needs merchant approval and credentials (D2-D3).

import { ServiceError, ErrorCode } from '../core/errors.ts';
import { unwrap, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';

export interface PaymentSession {
  paymentId: string;
  /** The provider's hosted payment page. */
  redirectUrl: string;
  expiresAt: string | null;
  /** 'test': no real money moves (the only provider today). */
  mode: 'test' | 'sandbox' | 'live';
}

export type PaymentStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown';

export interface CheckoutPaymentState {
  checkoutStatus: string;
  totalMinor: number;
  currency: string;
  reservationExpiresAt: string;
  /** The most recent attempt, if any. */
  payment: { id: string; status: PaymentStatus; mode: string; failureCode: string | null } | null;
  /** The server has confirmed payment. */
  paid: boolean;
}

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.Validation, 401: ErrorCode.Unauthenticated, 403: ErrorCode.Forbidden, 404: ErrorCode.NotFound,
  409: ErrorCode.Conflict, 429: ErrorCode.RateLimited,
};

export function paymentsService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Starts (or resumes) paying for one of your checkouts. */
    start(checkoutId: string): Promise<PaymentSession> {
      return ctx.run('payments.start', async () => {
        await ctx.requireUserId();
        const { data, error } = await db.functions.invoke<PaymentSession>('payments-session', {
          body: { checkoutId: v.uuid(checkoutId, 'checkoutId') },
        });
        if (error) {
          const response = (error as { context?: Response }).context;
          const status = response?.status ?? 0;
          let message: string | undefined;
          try {
            message = ((await response?.json()) as { error?: string } | undefined)?.error;
          } catch {
            message = undefined;
          }
          throw new ServiceError(HTTP_TO_CODE[status] ?? ErrorCode.ServerError, status >= 500 || !status ? undefined : message);
        }
        if (!data?.redirectUrl || !data.paymentId) throw new ServiceError(ErrorCode.ServerError);
        return data;
      });
    },

    /** What the server knows about a checkout's payment (poll after returning from the payment page). */
    state(checkoutId: string): Promise<CheckoutPaymentState> {
      return ctx.run('payments.state', async () => {
        await ctx.requireUserId();
        const id = v.uuid(checkoutId, 'checkoutId');
        const checkout = unwrap(await db.from('checkouts').select('status, total_minor, currency, reservation_expires_at').eq('id', id).maybeSingle());
        if (!checkout) throw new ServiceError(ErrorCode.NotFound);
        const payments = unwrap(await db.from('payments').select('id, status, mode, failure_code').eq('checkout_id', id)
          .order('created_at', { ascending: false }).limit(1)) ?? [];
        const p = payments[0];
        return {
          checkoutStatus: checkout.status,
          totalMinor: Number(checkout.total_minor),
          currency: checkout.currency,
          reservationExpiresAt: checkout.reservation_expires_at,
          payment: p ? { id: p.id, status: p.status as PaymentStatus, mode: p.mode, failureCode: p.failure_code } : null,
          paid: ['paid', 'partially_refunded', 'refunded'].includes(checkout.status),
        };
      });
    },
  };
}

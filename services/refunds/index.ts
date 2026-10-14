// Refunds and disputes (Stage I, migration 37). A refund is complete only
// when the payment provider confirms it (status 'succeeded'); requested,
// approved and processing refunds are promises, not money returned.

import { unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, ServiceError } from '../core/errors.ts';
import type { Tables } from '../database.types.ts';
import * as v from '../core/validate.ts';

export type Refund = Tables<'refunds'>;
export type RefundPolicy = Tables<'refund_policies'>;
export type Dispute = Tables<'disputes'>;
export type DisputeMessage = Tables<'dispute_messages'>;

/** Words for a refund status; only 'succeeded' means the money was returned. */
export const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: 'Requested, waiting for the seller',
  approved: 'Approved, waiting to be sent',
  rejected: 'Declined',
  processing: 'Being processed by the payment provider',
  pending: 'Being processed by the payment provider',
  succeeded: 'Refunded',
  failed: 'Refund failed; our team will follow up',
};

export function refundsService(ctx: ServiceContext) {
  const { db } = ctx;
  const call = <T>(operation: string, run: () => Promise<T>) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      return run();
    });

  return {
    /** Refunds of one order (its buyer and seller). */
    forOrder(orderId: string): Promise<Refund[]> {
      return call('refunds.forOrder', async () =>
        unwrap(await db.from('refunds').select('*').eq('order_id', v.uuid(orderId, 'orderId')).order('created_at')) ?? []);
    },

    /** Buyer: ask for a refund; no amount = everything not yet refunded. */
    request(orderId: string, reason: string, amountMinor?: number | null): Promise<string> {
      return call('refunds.request', async () => {
        const id = unwrap(await db.rpc('refund_request', {
          p_order_id: v.uuid(orderId, 'orderId'),
          p_reason: v.text(reason, 'reason', { min: 10, max: 500 }),
          p_amount_minor: amountMinor == null ? undefined : v.int(amountMinor, 'amountMinor', 1, Number.MAX_SAFE_INTEGER),
        }));
        if (typeof id !== 'string') throw new ServiceError(ErrorCode.ServerError);
        return id;
      });
    },

    /** Seller: approve (optionally less than requested) or decline with a note. */
    decide(refundId: string, approve: boolean, options: { amountMinor?: number | null; note?: string | null } = {}): Promise<void> {
      return call('refunds.decide', async () => {
        unwrap(await db.rpc('refund_decide', {
          p_refund_id: v.uuid(refundId, 'refundId'),
          p_approve: v.bool(approve, 'approve'),
          p_amount_minor: options.amountMinor == null ? undefined : v.int(options.amountMinor, 'amountMinor', 1, Number.MAX_SAFE_INTEGER),
          p_note: v.optionalText(options.note, 'note', { max: 500 }) ?? undefined,
        }));
      });
    },

    /** The community's refund settings (null: defaults; no policy published). */
    policy(communityId: string): Promise<RefundPolicy | null> {
      return call('refunds.policy', async () =>
        unwrap(await db.from('refund_policies').select('*').eq('community_id', v.uuid(communityId, 'communityId')).maybeSingle()));
    },

    /** marketplace.manage: refund settings and the community's own policy text. */
    savePolicy(communityId: string, input: { requestsEnabled: boolean; requestWindowDays: number; policyText?: string | null }): Promise<void> {
      return call('refunds.savePolicy', async () => {
        unwrap(await db.rpc('refund_policy_save', {
          p_community_id: v.uuid(communityId, 'communityId'),
          p_requests_enabled: v.bool(input.requestsEnabled, 'requestsEnabled'),
          p_request_window_days: v.int(input.requestWindowDays, 'requestWindowDays', 0, 365),
          p_policy_text: v.optionalText(input.policyText, 'policyText', { max: 4000 }) ?? (null as unknown as string),
        }));
      });
    },

    // ---- Disputes ----
    openDispute(orderId: string, reason: string): Promise<string> {
      return call('disputes.open', async () => {
        const id = unwrap(await db.rpc('dispute_open', {
          p_order_id: v.uuid(orderId, 'orderId'), p_reason: v.text(reason, 'reason', { min: 10, max: 2000 }),
        }));
        if (typeof id !== 'string') throw new ServiceError(ErrorCode.ServerError);
        return id;
      });
    },

    disputesForOrder(orderId: string): Promise<Dispute[]> {
      return call('disputes.forOrder', async () =>
        unwrap(await db.from('disputes').select('*').eq('order_id', v.uuid(orderId, 'orderId')).order('created_at', { ascending: false })) ?? []);
    },

    /** marketplace.manage: the community's disputes (open first). */
    disputes(communityId: string, status: 'open' | 'closed' = 'open'): Promise<Dispute[]> {
      return call('disputes.list', async () => {
        let q = db.from('disputes').select('*').eq('community_id', v.uuid(communityId, 'communityId')).order('created_at', { ascending: false }).limit(100);
        q = status === 'open' ? q.eq('status', 'open') : q.neq('status', 'open');
        return unwrap(await q) ?? [];
      });
    },

    dispute(disputeId: string): Promise<{ dispute: Dispute; messages: DisputeMessage[] }> {
      return call('disputes.get', async () => {
        const id = v.uuid(disputeId, 'disputeId');
        const dispute = unwrapOne(await db.from('disputes').select('*').eq('id', id).maybeSingle(), 'Dispute not found.');
        const messages = unwrap(await db.from('dispute_messages').select('*').eq('dispute_id', id).order('created_at')) ?? [];
        return { dispute, messages };
      });
    },

    addMessage(disputeId: string, body: string): Promise<void> {
      return call('disputes.addMessage', async () => {
        unwrap(await db.rpc('dispute_add_message', { p_dispute_id: v.uuid(disputeId, 'disputeId'), p_body: v.text(body, 'body', { max: 2000 }) }));
      });
    },

    /** marketplace.manage (not a party): decide, with an optional refund. */
    resolve(disputeId: string, input: { refund: boolean; amountMinor?: number | null; note: string }): Promise<void> {
      return call('disputes.resolve', async () => {
        unwrap(await db.rpc('dispute_resolve', {
          p_dispute_id: v.uuid(disputeId, 'disputeId'),
          p_refund: v.bool(input.refund, 'refund'),
          p_amount_minor: (input.refund ? v.int(input.amountMinor, 'amountMinor', 1, Number.MAX_SAFE_INTEGER) : 0) as number,
          p_note: v.text(input.note, 'note', { min: 3, max: 1000 }),
        }));
      });
    },

    withdraw(disputeId: string): Promise<void> {
      return call('disputes.withdraw', async () => {
        unwrap(await db.rpc('dispute_withdraw', { p_dispute_id: v.uuid(disputeId, 'disputeId') }));
      });
    },
  };
}

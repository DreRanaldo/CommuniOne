// Seller earnings (Stage K, migration 39): read-only figures from the
// ledger. They are records, not money in hand: CommuniOne does not pay
// sellers automatically, and payouts are recorded by an operator after
// they were sent outside the app.

import { unwrap, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';

export interface SellerBalance {
  currency: string;
  /** Payments captured for your orders and bookings. */
  earnedMinor: number;
  /** Refunds completed by the payment provider. */
  refundedMinor: number;
  /** Payouts recorded as sent to you. */
  paidOutMinor: number;
  /** What CommuniOne's records show as owed to you. */
  balanceMinor: number;
}

export interface StatementLine {
  id: string;
  at: string;
  kind: 'payment_captured' | 'refund' | 'payout' | 'adjustment';
  referenceType: string;
  referenceId: string;
  /** Positive: owed to you; negative: refunds and payouts. */
  amountMinor: number;
  currency: string;
}

export interface Payout {
  id: string;
  amountMinor: number;
  currency: string;
  method: string;
  externalReference: string;
  createdAt: string;
}

export function earningsService(ctx: ServiceContext) {
  const { db } = ctx;
  return {
    balance(communityId: string): Promise<SellerBalance> {
      return ctx.run('earnings.balance', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.rpc('seller_balance', { p_community_id: v.uuid(communityId, 'communityId') })) ?? [];
        const r = rows.find((x) => x.currency === 'JMD') ?? rows[0];
        return {
          currency: r?.currency ?? 'JMD',
          earnedMinor: Number(r?.earned_minor ?? 0),
          refundedMinor: Number(r?.refunded_minor ?? 0),
          paidOutMinor: Number(r?.paid_out_minor ?? 0),
          balanceMinor: Number(r?.balance_minor ?? 0),
        };
      });
    },

    statement(communityId: string, before?: string | null): Promise<StatementLine[]> {
      return ctx.run('earnings.statement', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.rpc('seller_statement', {
          p_community_id: v.uuid(communityId, 'communityId'),
          p_before: before ?? undefined,
          p_limit: 50,
        })) ?? [];
        return rows.map((r) => ({
          id: r.entry_id, at: r.created_at, kind: r.kind as StatementLine['kind'], referenceType: r.reference_type,
          referenceId: r.reference_id, amountMinor: Number(r.amount_minor), currency: r.currency,
        }));
      });
    },

    payouts(communityId: string): Promise<Payout[]> {
      return ctx.run('earnings.payouts', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.from('payouts').select('id, amount_minor, currency, method, external_reference, created_at')
          .eq('community_id', v.uuid(communityId, 'communityId')).order('created_at', { ascending: false }).limit(50)) ?? [];
        return rows.map((r) => ({ id: r.id, amountMinor: Number(r.amount_minor), currency: r.currency, method: r.method, externalReference: r.external_reference, createdAt: r.created_at }));
      });
    },
  };
}

// Display rules for checkout, payment and orders (Stages D-E). Totals, fees,
// tax and statuses are always the server's; the app only words them.
import { ErrorCode, isServiceError } from '@communione/services';
import { errorMessage } from '@/utils/errors';

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid, waiting for the seller',
  accepted: 'Accepted',
  rejected: 'Declined by the seller',
  processing: 'Being prepared',
  ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  delivery_failed: 'Delivery failed',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const orderStatusLabel = (status: string) => ORDER_STATUS_LABELS[status] ?? status;

export function orderStatusTone(status: string): 'success' | 'danger' | 'muted' {
  if (['delivered', 'completed', 'paid', 'accepted', 'ready_for_pickup'].includes(status)) return 'success';
  if (['rejected', 'cancelled', 'delivery_failed'].includes(status)) return 'danger';
  return 'muted';
}

const PROBLEMS: Record<string, string> = {
  choose_fulfillment: 'Choose pickup or delivery for each seller.',
  method_not_offered: 'That seller does not offer this option for every item.',
  address_required: 'Choose a delivery address.',
  delivery_not_available: 'That seller does not deliver to this address.',
  insufficient_stock: 'Some items no longer have enough stock. Review your cart.',
  unavailable: 'Some items are no longer for sale. Review your cart.',
  cart_empty: 'Your cart is empty.',
};

export const problemText = (problem: string) =>
  PROBLEMS[problem] ?? 'Something in your order needs attention.';

/** Checkout and payment refusals in plain words. */
export function orderError(error: unknown): string {
  if (isServiceError(error)) {
    if (/total changed/i.test(error.message))
      return 'The total changed. Review the new total and place the order again.';
    if (/reservation .* ended/i.test(error.message))
      return 'Your items are no longer reserved. Place the order again.';
    if (error.code === ErrorCode.Conflict && error.message) return error.message;
    if (error.code === ErrorCode.NotFound) return 'This order is no longer available.';
    if (error.code === ErrorCode.Forbidden) return "You don't have permission to do that.";
  }
  return errorMessage(error);
}

/** "1-2 days", "3 days", or null. */
export function estimateText(days: { min: number | null; max: number | null } | null): string | null {
  if (!days || (days.min === null && days.max === null)) return null;
  if (days.min !== null && days.max !== null && days.min !== days.max) return `${days.min}-${days.max} days`;
  const n = days.max ?? days.min!;
  return `${n} day${n === 1 ? '' : 's'}`;
}

import type { OrderDetail } from '@communione/services';
import { useState } from 'react';
import { Banner, Button, Card } from '@/components';
import { useServices } from '@/lib/dependencies';
import { orderError } from '../orderRules';

/**
 * What the viewer can do with an order now, offered from its state. The
 * server checks every action again (role, status, transitions).
 */
export function OrderActions({
  detail,
  onChanged,
  onPay,
}: {
  detail: OrderDetail;
  onChanged(): void;
  onPay(checkoutId: string): void;
}) {
  const { orders } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = detail.order;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  const buttons: React.ReactNode[] = [];
  if (
    detail.role === 'buyer' &&
    o.status === 'pending_payment' &&
    detail.checkout &&
    ['awaiting_payment', 'payment_failed'].includes(detail.checkout.status)
  ) {
    buttons.push(
      <Button
        key="pay"
        title="Pay now"
        icon="card-outline"
        onPress={() => onPay(o.checkout_id)}
        testID="order-pay"
      />,
    );
    buttons.push(
      <Button
        key="cancel"
        title="Cancel order"
        variant="ghost"
        disabled={busy}
        onPress={() => void run(() => orders.cancelCheckout(o.checkout_id))}
        testID="order-cancel"
      />,
    );
  }
  if (buttons.length === 0 && !error) return null;
  return (
    <Card testID="order-actions">
      {error ? <Banner tone="danger" message={error} testID="order-action-error" /> : null}
      {buttons}
    </Card>
  );
}

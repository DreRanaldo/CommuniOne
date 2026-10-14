import { ErrorCode, ServiceError, type OrderDetail } from '@communione/services';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { orderError } from '../orderRules';

type Form = null | 'reject' | 'sellerCancel' | 'buyerCancel' | 'failed' | 'dispatch' | 'pickup' | 'ready';

/**
 * What the viewer can do with an order now, offered from its state and the
 * viewer's role. The server checks every step again (role, status, the
 * allowed transition), so these buttons are a convenience, not the rule.
 */
export function OrderActions({
  detail,
  onChanged,
  onPay,
  onRequestRefund,
}: {
  detail: OrderDetail;
  onChanged(): void;
  onPay(checkoutId: string): void;
  onRequestRefund?: () => void;
}) {
  const styles = useStyles();
  const { orders } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [text, setText] = useState('');
  const [courier, setCourier] = useState('');
  const [tracking, setTracking] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const o = detail.order;
  const seller = detail.role === 'seller';
  const buyer = detail.role === 'buyer';

  const open = (f: Form) => {
    setForm(f);
    setText('');
    setError(null);
  };

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setForm(null);
      if (done) setNotice(done);
      onChanged();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  const button = (
    key: string,
    title: string,
    onPress: () => void,
    variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary',
  ) => (
    <Button
      key={key}
      title={title}
      variant={variant}
      disabled={busy}
      onPress={onPress}
      testID={`order-${key}`}
    />
  );

  const buttons: ReactNode[] = [];
  if (buyer) {
    if (
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
        button('cancel', 'Cancel order', () => void run(() => orders.cancelCheckout(o.checkout_id)), 'ghost'),
      );
    }
    if (o.status === 'paid')
      buttons.push(button('buyer-cancel', 'Cancel and get a refund', () => open('buyerCancel'), 'ghost'));
    if (o.status === 'delivered')
      buttons.push(
        button(
          'received',
          'I received my order',
          () => void run(() => orders.confirmReceived(o.id), 'Thank you. The order is complete.'),
        ),
      );
    if (
      onRequestRefund &&
      [
        'accepted',
        'processing',
        'ready_for_pickup',
        'out_for_delivery',
        'delivery_failed',
        'delivered',
        'completed',
      ].includes(o.status)
    )
      buttons.push(button('refund', 'Request a refund', onRequestRefund, 'secondary'));
  }
  if (seller) {
    if (o.status === 'paid') {
      buttons.push(button('accept', 'Accept order', () => void run(() => orders.accept(o.id))));
      buttons.push(button('reject', 'Decline order', () => open('reject'), 'ghost'));
    }
    if (o.status === 'accepted')
      buttons.push(
        button('process', 'Start preparing', () => void run(() => orders.startProcessing(o.id)), 'secondary'),
      );
    if (['accepted', 'processing'].includes(o.status)) {
      if (o.fulfillment_method === 'pickup')
        buttons.push(button('ready', 'Ready for pickup', () => open('ready')));
      else buttons.push(button('dispatch', 'Send for delivery', () => open('dispatch')));
    }
    if (o.status === 'delivery_failed')
      buttons.push(button('dispatch', 'Send again', () => open('dispatch')));
    if (o.status === 'ready_for_pickup')
      buttons.push(button('pickup', 'Enter pickup code', () => open('pickup')));
    if (o.status === 'out_for_delivery') {
      buttons.push(button('delivered', 'Mark delivered', () => void run(() => orders.markDelivered(o.id))));
      buttons.push(button('failed', 'Delivery failed', () => open('failed'), 'ghost'));
    }
    if (['accepted', 'processing', 'ready_for_pickup', 'delivery_failed'].includes(o.status))
      buttons.push(
        button('seller-cancel', "Can't fulfil: cancel and refund", () => open('sellerCancel'), 'ghost'),
      );
  }

  const confirm = (title: string, action: () => Promise<unknown>, done?: string) => (
    <View style={styles.row}>
      <Button title="Back" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setForm(null)} />
      <View style={styles.flex}>
        <Button
          title={title}
          loading={busy}
          onPress={() => void run(action, done)}
          testID="order-form-submit"
        />
      </View>
    </View>
  );

  let formView: ReactNode = null;
  if (form === 'reject' || form === 'sellerCancel' || form === 'failed' || form === 'buyerCancel') {
    const label =
      form === 'failed'
        ? 'What went wrong?'
        : form === 'buyerCancel'
          ? 'Reason (optional)'
          : 'Reason for the buyer';
    const action =
      form === 'reject'
        ? () => orders.reject(o.id, text)
        : form === 'sellerCancel'
          ? () => orders.sellerCancel(o.id, text)
          : form === 'failed'
            ? () => orders.markDeliveryFailed(o.id, text)
            : () => orders.buyerCancel(o.id, text || null);
    formView = (
      <>
        <TextField label={label} value={text} onChangeText={setText} multiline testID="order-form-text" />
        {form !== 'failed' ? (
          <Text variant="caption" tone="muted">
            The buyer is refunded in full. The refund reaches them once the payment provider processes it.
          </Text>
        ) : null}
        {confirm(form === 'failed' ? 'Record failed delivery' : 'Confirm', action)}
      </>
    );
  } else if (form === 'ready') {
    formView = (
      <>
        <TextField
          label="Pickup details for the buyer (optional)"
          placeholder="Where and when"
          value={text}
          onChangeText={setText}
          testID="order-form-text"
        />
        {confirm('Mark ready', () => orders.readyForPickup(o.id, text || null))}
      </>
    );
  } else if (form === 'pickup') {
    formView = (
      <>
        <TextField
          label="Buyer's 6-digit code"
          value={text}
          onChangeText={setText}
          keyboardType="number-pad"
          maxLength={6}
          testID="order-form-text"
        />
        {confirm(
          'Complete handover',
          async () => {
            const result = await orders.confirmPickup(o.id, text);
            if (result === 'wrong_code')
              throw new ServiceError(
                ErrorCode.Validation,
                'That code is not right. Ask the buyer to check it.',
              );
          },
          'Handed over. The order is complete.',
        )}
      </>
    );
  } else if (form === 'dispatch') {
    formView = (
      <>
        <Text variant="caption" tone="muted">
          Courier details are optional. Only add a tracking reference or link the courier gave you.
        </Text>
        <TextField
          label="Courier (optional)"
          value={courier}
          onChangeText={setCourier}
          testID="order-form-courier"
        />
        <TextField
          label="Tracking reference (optional)"
          value={tracking}
          onChangeText={setTracking}
          testID="order-form-tracking"
        />
        <TextField
          label="Tracking link (optional)"
          value={trackingUrl}
          onChangeText={setTrackingUrl}
          autoCapitalize="none"
          keyboardType="url"
        />
        {confirm('Mark sent', () =>
          orders.dispatch(o.id, {
            courierName: courier || null,
            trackingReference: tracking || null,
            trackingUrl: trackingUrl || null,
          }),
        )}
      </>
    );
  }

  if (buttons.length === 0 && !error && !notice) return null;
  return (
    <Card testID="order-actions">
      {error ? <Banner tone="danger" message={error} testID="order-action-error" /> : null}
      {notice ? <Banner tone="success" message={notice} testID="order-action-notice" /> : null}
      {formView ?? buttons}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

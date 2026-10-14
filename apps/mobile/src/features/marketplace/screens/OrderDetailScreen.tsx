import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { OrderDetail } from '@communione/services';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { FULFILLMENT_LABELS, formatMoney } from '../marketRules';
import { orderError, orderStatusLabel, orderStatusTone } from '../orderRules';
import { OrderActions } from '../components/OrderActions';
import { OrderRefunds } from '../components/OrderRefunds';

type Props = NativeStackScreenProps<CommunityStackParamList, 'OrderDetail'>;

/**
 * One order, read from the server, for its buyer or (once paid) its seller.
 * Every action is offered from the order's state and checked again by the
 * server.
 */
export function OrderDetailScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { orders } = useServices();
  const { orderId } = route.params;
  // Refreshed in place after every action (the screen keeps showing the
  // previous state, and any confirmation, until the new one arrives).
  const [detail, setDetail] = useState<{ data: OrderDetail | null; error: unknown }>({
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      orders.order(orderId).then(
        (data) => current && setDetail({ data, error: null }),
        (error: unknown) => current && setDetail((d) => ({ data: d.data, error })),
      );
      return () => {
        current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` deliberately forces a reload
    }, [orders, orderId, attempt]),
  );

  if (detail.error && !detail.data)
    return (
      <ErrorState
        title="This order could not be loaded"
        message={orderError(detail.error)}
        onRetry={reload}
      />
    );
  if (!detail.data) return <LoadingState label="Loading the order…" />;
  const d: OrderDetail = detail.data;
  const o = d.order;
  const contact = o.contact_snapshot as { name?: string; phone?: string } | null;
  const address = o.address_snapshot as {
    recipient_name?: string;
    line1?: string;
    line2?: string | null;
    town?: string;
    parish?: string;
    instructions?: string | null;
  } | null;

  return (
    <Screen testID="order-detail">
      <Card>
        <View style={styles.row}>
          <Icon name="receipt-outline" size={24} color="primary" />
          <View style={styles.flex}>
            <Text variant="heading">
              {d.role === 'buyer' ? o.seller_name : `Order from ${contact?.name ?? 'a buyer'}`}
            </Text>
            <Text tone={orderStatusTone(o.status)} testID="order-detail-status">
              {orderStatusLabel(o.status)}
            </Text>
            {o.status_reason ? (
              <Text tone="muted" variant="caption">
                {o.status_reason}
              </Text>
            ) : null}
          </View>
        </View>
        <Text
          variant="caption"
          tone="muted"
        >{`Placed ${new Date(o.created_at).toLocaleString()} · ${FULFILLMENT_LABELS[o.fulfillment_method] ?? o.fulfillment_method}`}</Text>
      </Card>

      {d.pickupCode && o.status === 'ready_for_pickup' ? (
        <Card testID="order-pickup-code">
          <Text variant="label">Your pickup code</Text>
          <Text variant="display" accessibilityLabel={`Pickup code ${d.pickupCode.split('').join(' ')}`}>
            {d.pickupCode}
          </Text>
          <Text variant="caption" tone="muted">
            Tell the seller this code when you collect your order. Do not share it before then.
          </Text>
        </Card>
      ) : null}
      {d.shipment ? (
        <Card testID="order-shipment">
          <Text variant="label">Delivery</Text>
          {d.shipment.courier_name ? <Text>{`Courier: ${d.shipment.courier_name}`}</Text> : null}
          {d.shipment.tracking_reference ? (
            <Text>{`Tracking reference: ${d.shipment.tracking_reference}`}</Text>
          ) : null}
          {d.shipment.tracking_url ? (
            <Text tone="muted" variant="caption">
              {d.shipment.tracking_url}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            As recorded by the seller. CommuniOne does not track deliveries live.
          </Text>
        </Card>
      ) : null}

      <OrderActions
        detail={d}
        onChanged={reload}
        onPay={(checkoutId) => navigation.navigate('Payment', { checkoutId })}
        onRequestRefund={() => navigation.navigate('RefundRequest', { orderId })}
      />
      <OrderRefunds
        detail={d}
        version={attempt}
        onChanged={reload}
        onOpenDispute={(disputeId) => navigation.navigate('Dispute', { disputeId })}
        onNewDispute={() => navigation.navigate('Dispute', { orderId })}
      />

      <Card testID="order-items">
        {d.items.map((i) => (
          <View key={i.id} style={styles.row}>
            <Text style={styles.flex}>{`${i.quantity} × ${i.title_snapshot}`}</Text>
            <Text>{formatMoney(Number(i.line_total_minor), o.currency)}</Text>
          </View>
        ))}
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.flex}>Items</Text>
          <Text>{formatMoney(Number(o.subtotal_minor), o.currency)}</Text>
        </View>
        {Number(o.delivery_minor) > 0 ? (
          <View style={styles.row}>
            <Text style={styles.flex}>Delivery</Text>
            <Text>{formatMoney(Number(o.delivery_minor), o.currency)}</Text>
          </View>
        ) : null}
        {Number(o.tax_minor) > 0 ? (
          <View style={styles.row}>
            <Text style={styles.flex}>GCT</Text>
            <Text>{formatMoney(Number(o.tax_minor), o.currency)}</Text>
          </View>
        ) : null}
        <View style={styles.row}>
          <Text variant="bodyStrong" style={styles.flex}>
            Total
          </Text>
          <Text variant="bodyStrong" testID="order-total">
            {formatMoney(Number(o.total_minor), o.currency)}
          </Text>
        </View>
      </Card>

      {address ? (
        <Card>
          <Text variant="label">Delivery address</Text>
          <Text>{address.recipient_name}</Text>
          <Text tone="muted">{`${address.line1}${address.line2 ? `, ${address.line2}` : ''}, ${address.town}, ${address.parish}`}</Text>
          {address.instructions ? (
            <Text tone="muted" variant="caption">
              {address.instructions}
            </Text>
          ) : null}
        </Card>
      ) : null}
      {d.role === 'seller' && contact ? (
        <Card testID="order-contact">
          <Text variant="label">Buyer contact</Text>
          <Text>{`${contact.name ?? ''} · ${contact.phone ?? ''}`}</Text>
        </Card>
      ) : null}

      <Card testID="order-history">
        <Text variant="label">History</Text>
        {d.events.map((e) => (
          <View key={e.id} style={styles.row}>
            <Icon name="ellipse" size={8} color="textMuted" />
            <View style={styles.flex}>
              <Text>{orderStatusLabel(e.to_status)}</Text>
              <Text variant="caption" tone="muted">
                {`${new Date(e.created_at).toLocaleString()}${e.reason ? ` · ${e.reason}` : ''}`}
              </Text>
            </View>
          </View>
        ))}
      </Card>
      {d.role === 'buyer' && ['completed', 'cancelled', 'rejected', 'delivered'].includes(o.status) ? (
        <Button
          title="Buy again"
          variant="secondary"
          icon="refresh"
          onPress={() => {
            const first = d.items.find((i) => i.listing_id);
            if (first?.listing_id) navigation.navigate('Listing', { listingId: first.listing_id });
          }}
        />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1, gap: 2 },
  divider: { height: 1, backgroundColor: t.colors.border, marginVertical: t.spacing.xs },
}));

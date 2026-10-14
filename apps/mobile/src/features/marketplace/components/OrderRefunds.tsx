import { REFUND_STATUS_LABELS, type Dispute, type OrderDetail, type Refund } from '@communione/services';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Text, TextField } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { formatMoney, parsePrice } from '../marketRules';
import { orderError } from '../orderRules';

/**
 * Refunds and disputes of one order. Labels come from the server status;
 * only "Refunded" means the payment provider returned the money.
 */
export function OrderRefunds({
  detail,
  version,
  onChanged,
  onOpenDispute,
  onNewDispute,
}: {
  detail: OrderDetail;
  version: number;
  onChanged(): void;
  onOpenDispute(disputeId: string): void;
  onNewDispute(): void;
}) {
  const styles = useStyles();
  const { refunds } = useServices();
  const orderId = detail.order.id;
  const load = useCallback(
    // `version` reloads after an order action.
    () =>
      Promise.all([refunds.forOrder(orderId), refunds.disputesForOrder(orderId), Promise.resolve(version)]),
    [refunds, orderId, version],
  );
  const data = useAsync(load);
  const [deciding, setDeciding] = useState<Refund | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data.status !== 'success') return null;
  const [list, disputes] = data.data as [Refund[], Dispute[], number];
  const open = disputes.find((d) => d.status === 'open');
  const currency = detail.order.currency;
  const canDispute =
    detail.role === 'buyer' &&
    !open &&
    list.some((r) => r.status === 'rejected') &&
    !['cancelled', 'rejected'].includes(detail.order.status);
  if (list.length === 0 && disputes.length === 0) return null;

  const decide = async (approve: boolean) => {
    if (!deciding) return;
    setError(null);
    let minor: number | null = null;
    if (approve && amount.trim()) {
      const parsed = parsePrice(amount);
      if ('error' in parsed || parsed.minor === null) return setError('Enter an amount like 1500.');
      minor = parsed.minor;
    }
    setBusy(true);
    try {
      await refunds.decide(deciding.id, approve, { amountMinor: minor, note: note || null });
      setDeciding(null);
      data.reload();
      onChanged();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="order-refunds">
      <Text variant="label">Refunds</Text>
      {error ? <Banner tone="danger" message={error} /> : null}
      {list.map((r) => (
        <View key={r.id} style={styles.row} testID={`refund-${r.id}`}>
          <View style={styles.flex}>
            <Text variant="bodyStrong">{formatMoney(Number(r.amount_minor), currency)}</Text>
            <Text
              tone={
                r.status === 'succeeded'
                  ? 'success'
                  : r.status === 'rejected' || r.status === 'failed'
                    ? 'danger'
                    : 'muted'
              }
              testID={`refund-status-${r.id}`}
            >
              {REFUND_STATUS_LABELS[r.status] ?? r.status}
            </Text>
            <Text variant="caption" tone="muted">
              {r.reason}
            </Text>
            {r.decision_note ? <Text variant="caption">{`Seller: ${r.decision_note}`}</Text> : null}
          </View>
          {detail.role === 'seller' && r.status === 'requested' && deciding?.id !== r.id ? (
            <Button
              title="Review"
              variant="secondary"
              fullWidth={false}
              onPress={() => setDeciding(r)}
              testID={`refund-review-${r.id}`}
            />
          ) : null}
        </View>
      ))}
      {deciding ? (
        <View style={styles.form}>
          <TextField
            label={`Approve a smaller amount (optional, up to ${formatMoney(Number(deciding.amount_minor), currency)})`}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            testID="refund-decide-amount"
          />
          <TextField
            label="Note to the buyer (required to decline)"
            value={note}
            onChangeText={setNote}
            testID="refund-decide-note"
          />
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button
                title="Decline"
                variant="ghost"
                disabled={busy}
                onPress={() => void decide(false)}
                testID="refund-decline"
              />
            </View>
            <View style={styles.flex}>
              <Button
                title="Approve"
                loading={busy}
                onPress={() => void decide(true)}
                testID="refund-approve"
              />
            </View>
          </View>
        </View>
      ) : null}
      {disputes.map((d) => (
        <Button
          key={d.id}
          title={d.status === 'open' ? 'Dispute under review' : 'Dispute decided'}
          variant="secondary"
          icon="chatbubbles-outline"
          onPress={() => onOpenDispute(d.id)}
          testID={`order-dispute-${d.id}`}
        />
      ))}
      {canDispute ? (
        <Button
          title="Ask the community to decide"
          variant="secondary"
          onPress={onNewDispute}
          testID="order-new-dispute"
        />
      ) : null}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1, gap: 2 },
  form: { gap: t.spacing.sm },
}));

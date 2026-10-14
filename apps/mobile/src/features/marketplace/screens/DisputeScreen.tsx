import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAuth } from '@/features/auth/AuthProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { parsePrice } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Dispute'>;

const STATUS: Record<string, string> = {
  open: 'Under review by the community',
  resolved_refund: 'Decided: refund',
  resolved_no_refund: 'Decided: no refund',
  withdrawn: 'Withdrawn',
};

/**
 * A dispute (Stage I): the buyer opens it, both parties write, and a
 * marketplace manager of the community who is not a party decides. The
 * server enforces who may see, write and decide.
 */
export function DisputeScreen({ navigation, route }: Props) {
  const { disputeId, orderId } = route.params;
  if (!disputeId)
    return (
      <OpenDispute orderId={orderId!} onOpened={(id) => navigation.replace('Dispute', { disputeId: id })} />
    );
  return <DisputeThread disputeId={disputeId} />;
}

function OpenDispute({ orderId, onOpened }: { orderId: string; onOpened(id: string): void }) {
  const { refunds } = useServices();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onOpened(await refunds.openDispute(orderId, reason));
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="dispute-open">
      {error ? <Banner tone="danger" message={error} testID="dispute-error" /> : null}
      <Text>
        The community&apos;s marketplace managers will read both sides and decide. Describe the problem and
        what you would like.
      </Text>
      <TextField
        label="What happened?"
        value={reason}
        onChangeText={setReason}
        multiline
        testID="dispute-reason"
      />
      <Button title="Open dispute" loading={busy} onPress={() => void submit()} testID="dispute-submit" />
    </Screen>
  );
}

function DisputeThread({ disputeId }: { disputeId: string }) {
  const styles = useStyles();
  const { refunds } = useServices();
  const permissions = useCommunityPermissions();
  const { session } = useAuth();
  const me = session?.user.id;
  const load = useCallback(() => refunds.dispute(disputeId), [refunds, disputeId]);
  const data = useAsync(load);
  const [message, setMessage] = useState('');
  const [refund, setRefund] = useState(true);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <ErrorState message={orderError(data.error)} onRetry={data.reload} />;
  const { dispute: d, messages } = data.data;
  const party = me === d.buyer_user_id || me === d.seller_user_id;
  const canDecide = d.status === 'open' && !party && permissions.can('marketplace.manage');

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage('');
      data.reload();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  const decide = () => {
    let minor: number | null = null;
    if (refund) {
      const parsed = parsePrice(amount);
      if ('error' in parsed || parsed.minor === null) return setError('Enter the refund amount.');
      minor = parsed.minor;
    }
    void act(() => refunds.resolve(disputeId, { refund, amountMinor: minor, note }));
  };

  return (
    <Screen testID="dispute-screen">
      {error ? <Banner tone="danger" message={error} testID="dispute-error" /> : null}
      <Card>
        <Text variant="label" testID="dispute-status">
          {STATUS[d.status] ?? d.status}
        </Text>
        <Text>{d.reason}</Text>
        {d.resolution_note ? <Text tone="muted">{`Decision: ${d.resolution_note}`}</Text> : null}
        {d.status === 'resolved_refund' ? (
          <Text variant="caption" tone="muted">
            The refund is complete only once the payment provider processes it. Check the order for its
            status.
          </Text>
        ) : null}
      </Card>
      {messages.map((m) => (
        <Card key={m.id}>
          <Text variant="caption" tone="muted">
            {m.author_user_id === d.buyer_user_id
              ? 'Buyer'
              : m.author_user_id === d.seller_user_id
                ? 'Seller'
                : 'Community manager'}
          </Text>
          <Text>{m.body}</Text>
        </Card>
      ))}
      {d.status === 'open' ? (
        <>
          <TextField
            label="Add a message"
            value={message}
            onChangeText={setMessage}
            multiline
            testID="dispute-message"
          />
          <Button
            title="Send"
            variant="secondary"
            disabled={busy || !message.trim()}
            onPress={() => void act(() => refunds.addMessage(disputeId, message))}
            testID="dispute-send"
          />
        </>
      ) : null}
      {canDecide ? (
        <Card testID="dispute-decide">
          <Text variant="label">Decide</Text>
          <View style={styles.row}>
            <Text style={styles.flex}>Refund the buyer</Text>
            <Switch
              value={refund}
              onValueChange={setRefund}
              accessibilityLabel="Refund the buyer"
              testID="dispute-refund"
            />
          </View>
          {refund ? (
            <TextField
              label="Refund amount (J$)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              testID="dispute-amount"
            />
          ) : null}
          <TextField
            label="Reason for the decision"
            value={note}
            onChangeText={setNote}
            multiline
            testID="dispute-note"
          />
          <Button title="Record decision" loading={busy} onPress={decide} testID="dispute-resolve" />
        </Card>
      ) : null}
      {d.status === 'open' && me === d.buyer_user_id ? (
        <Button
          title="Withdraw dispute"
          variant="ghost"
          disabled={busy}
          onPress={() => void act(() => refunds.withdraw(disputeId))}
          testID="dispute-withdraw"
        />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

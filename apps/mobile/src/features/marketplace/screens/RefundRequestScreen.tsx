import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { ChipRow } from '../components/ChipRow';
import { formatMoney, parsePrice } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'RefundRequest'>;

/**
 * Ask the seller for a refund (Stage I). The seller decides; the money is
 * returned only when the payment provider completes the refund.
 */
export function RefundRequestScreen({ navigation, route }: Props) {
  const community = useCommunity();
  const { orders, refunds } = useServices();
  const { orderId } = route.params;
  const load = useCallback(
    () =>
      Promise.all([orders.order(orderId), refunds.forOrder(orderId), refunds.policy(community.community_id)]),
    [orders, refunds, orderId, community.community_id],
  );
  const data = useAsync(load);
  const [scope, setScope] = useState<'all' | 'part'>('all');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <ErrorState message={orderError(data.error)} onRetry={data.reload} />;
  const [detail, existing, policy] = data.data;
  const used = existing
    .filter((r) => !['rejected', 'failed'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount_minor), 0);
  const left = Number(detail.order.total_minor) - used;

  const submit = async () => {
    setError(null);
    let minor: number | null = null;
    if (scope === 'part') {
      const parsed = parsePrice(amount);
      if ('error' in parsed || parsed.minor === null) return setError('Enter the amount you are asking for.');
      if (parsed.minor > left)
        return setError(`You can ask for at most ${formatMoney(left, detail.order.currency)}.`);
      minor = parsed.minor;
    }
    setBusy(true);
    try {
      await refunds.request(orderId, reason, minor);
      navigation.goBack();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="refund-request">
      {error ? <Banner tone="danger" message={error} testID="refund-error" /> : null}
      <Card>
        <Text variant="label">{`Order from ${detail.order.seller_name}`}</Text>
        <Text tone="muted">{`Up to ${formatMoney(left, detail.order.currency)} can still be refunded.`}</Text>
      </Card>
      {policy?.policy_text ? (
        <Card testID="refund-policy">
          <Text variant="label">{`${community.name}'s refund policy`}</Text>
          <Text>{policy.policy_text}</Text>
        </Card>
      ) : null}
      <ChipRow<'all' | 'part'>
        label="How much"
        options={[
          { value: 'all', label: `Everything (${formatMoney(left, detail.order.currency)})` },
          { value: 'part', label: 'Part of it' },
        ]}
        value={scope}
        onChange={setScope}
        testID="refund-scope"
      />
      {scope === 'part' ? (
        <TextField
          label="Amount (J$)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          testID="refund-amount"
        />
      ) : null}
      <TextField
        label="What went wrong?"
        value={reason}
        onChangeText={setReason}
        multiline
        testID="refund-reason"
      />
      <Text variant="caption" tone="muted">
        The seller approves or declines. If they decline, you can ask the community&apos;s marketplace
        managers to decide.
      </Text>
      <Button title="Send request" loading={busy} onPress={() => void submit()} testID="refund-submit" />
    </Screen>
  );
}

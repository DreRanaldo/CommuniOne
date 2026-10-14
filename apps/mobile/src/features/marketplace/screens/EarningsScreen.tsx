import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { View } from 'react-native';
import { Banner, Card, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { formatMoney } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Earnings'>;

const KIND: Record<string, string> = {
  payment_captured: 'Sale paid',
  refund: 'Refund',
  payout: 'Payout recorded',
  adjustment: 'Adjustment',
};

/**
 * A seller's earnings in this community (Stage K), from CommuniOne's
 * ledger. Figures are records: sellers are not paid automatically, and
 * payouts appear once an operator records money sent outside the app.
 */
export function EarningsScreen(_props: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const { earnings } = useServices();
  const load = useCallback(
    () =>
      Promise.all([
        earnings.balance(community.community_id),
        earnings.statement(community.community_id),
        earnings.payouts(community.community_id),
      ]),
    [earnings, community.community_id],
  );
  const data = useAsync(load);
  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <ErrorState message={orderError(data.error)} onRetry={data.reload} />;
  const [b, lines, payouts] = data.data;
  const row = (label: string, value: number, testID?: string, strong = false) => (
    <View style={styles.row}>
      <Text variant={strong ? 'heading' : 'body'} style={styles.flex}>
        {label}
      </Text>
      <Text variant={strong ? 'heading' : 'body'} testID={testID}>
        {formatMoney(value, b.currency)}
      </Text>
    </View>
  );
  return (
    <Screen testID="earnings-screen">
      <Banner
        message="Payouts are not automatic. Amounts here are CommuniOne's records; a payout shows once it has been sent to you and recorded."
        testID="earnings-note"
      />
      <Card>
        {row('Sales paid', b.earnedMinor)}
        {row('Refunds', -b.refundedMinor)}
        {row('Payouts recorded', -b.paidOutMinor)}
        {row('Balance owed to you', b.balanceMinor, 'earnings-balance', true)}
      </Card>
      {payouts.length ? (
        <Card>
          <Text variant="label">Payouts</Text>
          {payouts.map((p) => (
            <View key={p.id} style={styles.row}>
              <Text
                style={styles.flex}
              >{`${new Date(p.createdAt).toLocaleDateString()} · ${p.externalReference}`}</Text>
              <Text>{formatMoney(p.amountMinor, p.currency)}</Text>
            </View>
          ))}
        </Card>
      ) : null}
      <Card testID="earnings-statement">
        <Text variant="label">Statement</Text>
        {lines.length === 0 ? <Text tone="muted">Nothing yet.</Text> : null}
        {lines.map((l) => (
          <View key={l.id} style={styles.row}>
            <Text
              style={styles.flex}
            >{`${new Date(l.at).toLocaleDateString()} · ${KIND[l.kind] ?? l.kind}`}</Text>
            <Text tone={l.amountMinor < 0 ? 'danger' : 'success'}>
              {formatMoney(l.amountMinor, l.currency)}
            </Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

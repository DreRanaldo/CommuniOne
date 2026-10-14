import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RefundPolicy } from '@communione/services';
import { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'RefundSettings'>;

/**
 * marketplace.manage: whether buyers can request refunds, for how long after
 * an order completes, and the community's own policy text. CommuniOne
 * provides no policy wording of its own.
 */
export function RefundSettingsScreen({ navigation }: Props) {
  const community = useCommunity();
  const { refunds } = useServices();
  const load = useCallback(() => refunds.policy(community.community_id), [refunds, community.community_id]);
  const data = useAsync(load);
  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <ErrorState message={orderError(data.error)} onRetry={data.reload} />;
  return <Form initial={data.data} onSaved={() => navigation.goBack()} />;
}

function Form({ initial, onSaved }: { initial: RefundPolicy | null; onSaved(): void }) {
  const styles = useStyles();
  const community = useCommunity();
  const { refunds } = useServices();
  const [enabled, setEnabled] = useState(initial?.requests_enabled ?? true);
  const [days, setDays] = useState(String(initial?.request_window_days ?? 14));
  const [text, setText] = useState(initial?.policy_text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 0 || n > 365) return setError('Enter a number of days from 0 to 365.');
    setBusy(true);
    setError(null);
    try {
      await refunds.savePolicy(community.community_id, {
        requestsEnabled: enabled,
        requestWindowDays: n,
        policyText: text || null,
      });
      onSaved();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="refund-settings">
      {error ? <Banner tone="danger" message={error} /> : null}
      <View style={styles.row}>
        <Text style={styles.flex}>Buyers can request refunds in the app</Text>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          accessibilityLabel="Buyers can request refunds"
          testID="refund-settings-enabled"
        />
      </View>
      <TextField
        label="Days after completion to request a refund"
        value={days}
        onChangeText={setDays}
        keyboardType="number-pad"
        testID="refund-settings-days"
      />
      <TextField
        label="Your community's refund policy (optional)"
        value={text}
        onChangeText={setText}
        multiline
        testID="refund-settings-text"
      />
      <Text variant="caption" tone="muted">
        Shown to buyers exactly as written. Get advice before publishing terms; CommuniOne does not write them
        for you.
      </Text>
      <Button title="Save" loading={busy} onPress={() => void save()} testID="refund-settings-save" />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

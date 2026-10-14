import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, Screen, Text, Card } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { ChipRow } from '../components/ChipRow';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Disputes'>;

/** marketplace.manage: the community's marketplace disputes. */
export function DisputesScreen({ navigation }: Props) {
  const community = useCommunity();
  const { refunds } = useServices();
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const load = useCallback(
    () => refunds.disputes(community.community_id, which),
    [refunds, community.community_id, which],
  );
  const list = useAsync(load);
  const { reload } = list;
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else reload();
    }, [reload]),
  );
  return (
    <Screen testID="disputes-screen">
      <ChipRow<'open' | 'closed'>
        label="Disputes to show"
        options={[
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Decided' },
        ]}
        value={which}
        onChange={setWhich}
      />
      {list.status === 'loading' ? <LoadingState /> : null}
      {list.status === 'error' ? <ErrorState message={orderError(list.error)} onRetry={list.reload} /> : null}
      {list.status === 'success' && list.data.length === 0 ? (
        <EmptyState
          icon="chatbubbles-outline"
          title={which === 'open' ? 'No open disputes' : 'No decided disputes'}
        />
      ) : null}
      {list.status === 'success'
        ? list.data.map((d) => (
            <Card
              key={d.id}
              onPress={() => navigation.navigate('Dispute', { disputeId: d.id })}
              accessibilityLabel="Open dispute"
              testID={`dispute-row-${d.id}`}
            >
              <Text numberOfLines={2}>{d.reason}</Text>
              <Text variant="caption" tone="muted">
                {new Date(d.created_at).toLocaleDateString()}
              </Text>
            </Card>
          ))
        : null}
    </Screen>
  );
}

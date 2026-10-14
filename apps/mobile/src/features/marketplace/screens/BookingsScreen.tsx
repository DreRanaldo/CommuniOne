import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BOOKING_STATUS_LABELS } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { formatLocal } from '../bookingRules';
import { ChipRow } from '../components/ChipRow';
import { formatMoney } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Bookings'>;

/** Service bookings in the current community: the ones you made, or (sellers) received. */
export function BookingsScreen({ navigation, route }: Props) {
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { bookings } = useServices();
  const [as, setAs] = useState<'buyer' | 'seller'>(route.params?.as ?? 'buyer');
  const load = useCallback(
    () => bookings.list({ communityId: community.community_id, as }),
    [bookings, community.community_id, as],
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
    <Screen testID="bookings-screen">
      {permissions.can('marketplace.sell') ? (
        <ChipRow<'buyer' | 'seller'>
          label="Bookings to show"
          options={[
            { value: 'buyer', label: 'Booked by me' },
            { value: 'seller', label: 'For my services' },
          ]}
          value={as}
          onChange={setAs}
          testID="bookings-side"
        />
      ) : null}
      {list.status === 'loading' ? <LoadingState /> : null}
      {list.status === 'error' ? <ErrorState message={orderError(list.error)} onRetry={list.reload} /> : null}
      {list.status === 'success' && list.data.items.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title="No bookings yet"
          message="Services you book appear here."
        />
      ) : null}
      {list.status === 'success'
        ? list.data.items.map((b) => (
            <Card
              key={b.id}
              onPress={() => navigation.navigate('BookingDetail', { bookingId: b.id })}
              accessibilityLabel={`${b.title_snapshot}, ${BOOKING_STATUS_LABELS[b.status] ?? b.status}`}
              testID={`booking-row-${b.id}`}
            >
              <Text variant="bodyStrong">{b.title_snapshot}</Text>
              <Text tone="muted">{formatLocal(b.startsAt)}</Text>
              <Text variant="caption" testID={`booking-status-${b.id}`}>
                {BOOKING_STATUS_LABELS[b.status] ?? b.status}
                {b.amount_minor ? ` · ${formatMoney(Number(b.amount_minor), b.currency)}` : ''}
              </Text>
            </Card>
          ))
        : null}
    </Screen>
  );
}

import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Order, OrderItem } from '@communione/services';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, EmptyState, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { ChipRow } from '../components/ChipRow';
import { formatMoney } from '../marketRules';
import { orderError, orderStatusLabel, orderStatusTone } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Orders'>;
type Side = 'purchases' | 'sales';
type Row = Order & { items: OrderItem[] };

/** Your purchases (and, for sellers, sales) in the current community, newest first. */
export function OrdersScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { orders } = useServices();
  const canSell = permissions.can('marketplace.sell');
  const [side, setSide] = useState<Side>(route.params?.side ?? 'purchases');
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    rows: Row[];
    cursor: string | null;
    error?: unknown;
  }>({
    status: 'loading',
    rows: [],
    cursor: null,
  });
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const fetchPage = useCallback(
    (cursor?: string | null) =>
      side === 'sales'
        ? orders.sellerOrders({ communityId: community.community_id, cursor: cursor ?? undefined })
        : orders.myOrders({ communityId: community.community_id, cursor: cursor ?? undefined }),
    [orders, side, community.community_id],
  );

  useFocusEffect(
    useCallback(() => {
      let current = true;
      fetchPage().then(
        (page) => current && setState({ status: 'ready', rows: page.items, cursor: page.nextCursor }),
        (error: unknown) => current && setState({ status: 'error', rows: [], cursor: null, error }),
      );
      return () => {
        current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` deliberately forces a reload (Try again)
    }, [fetchPage, attempt]),
  );

  const loadMore = async () => {
    setMore(true);
    try {
      const page = await fetchPage(state.cursor);
      setState((s) => ({ status: 'ready', rows: [...s.rows, ...page.items], cursor: page.nextCursor }));
    } finally {
      setMore(false);
    }
  };

  const header = canSell ? (
    <ChipRow<Side>
      label="Orders to show"
      options={[
        { value: 'purchases', label: 'Purchases' },
        { value: 'sales', label: 'Sales' },
      ]}
      value={side}
      onChange={(s) => {
        setSide(s);
        setState({ status: 'loading', rows: [], cursor: null });
      }}
      testID="orders-side"
    />
  ) : null;

  if (state.status === 'loading')
    return (
      <Screen>
        {header}
        <LoadingState label="Loading orders…" />
      </Screen>
    );
  if (state.status === 'error')
    return (
      <ErrorState
        title="Orders could not be loaded"
        message={orderError(state.error)}
        onRetry={() => {
          setState({ status: 'loading', rows: [], cursor: null });
          setAttempt((a) => a + 1);
        }}
      />
    );

  return (
    <Screen testID="orders-screen">
      {header}
      <Button
        title="Service bookings"
        icon="calendar-outline"
        variant="secondary"
        onPress={() => navigation.navigate('Bookings', side === 'sales' ? { as: 'seller' } : undefined)}
        testID="orders-bookings"
      />
      {state.rows.length === 0 ? (
        <EmptyState
          icon="receipt-outline"
          title={side === 'sales' ? 'No sales yet' : 'No orders yet'}
          message={
            side === 'sales'
              ? 'Orders for your listings appear here.'
              : `What you buy in ${community.name} appears here.`
          }
        />
      ) : null}
      {state.rows.map((o) => {
        const count = o.items.reduce((n, i) => n + i.quantity, 0);
        return (
          <Pressable
            key={o.id}
            accessibilityRole="button"
            accessibilityLabel={`Order from ${o.seller_name}, ${orderStatusLabel(o.status)}`}
            onPress={() => navigation.navigate('OrderDetail', { orderId: o.id })}
            style={styles.row}
            testID={`order-row-${o.id}`}
          >
            <Icon name="bag-handle-outline" size={22} color="primary" />
            <View style={styles.flex}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {side === 'sales'
                  ? ((o.contact_snapshot as { name?: string } | null)?.name ?? 'Buyer')
                  : o.seller_name}
              </Text>
              <Text tone="muted" variant="caption" numberOfLines={1}>
                {`${count} item${count === 1 ? '' : 's'} · ${new Date(o.created_at).toLocaleDateString()}`}
              </Text>
              <Text tone={orderStatusTone(o.status)} variant="caption" testID={`order-status-${o.id}`}>
                {orderStatusLabel(o.status)}
              </Text>
            </View>
            <Text variant="bodyStrong">{formatMoney(Number(o.total_minor), o.currency)}</Text>
          </Pressable>
        );
      })}
      {state.cursor ? (
        <Button title="Load more" variant="secondary" loading={more} onPress={() => void loadMore()} />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  flex: { flex: 1, gap: 2 },
}));

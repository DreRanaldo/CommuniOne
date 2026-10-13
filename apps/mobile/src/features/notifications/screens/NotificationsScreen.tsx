import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Notification } from '@communione/services';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Banner, Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { NotificationItem } from '../NotificationItem';
import { useNotificationList, type NotificationView } from '../useNotificationList';
import { useOpenNotification } from '../useOpenNotification';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

const VIEWS: { view: NotificationView; label: string; empty: string }[] = [
  { view: 'all', label: 'All', empty: 'No notifications yet.' },
  { view: 'unread', label: 'Unread', empty: "You're all caught up." },
];

/**
 * The notification center: the user's own notifications (the database
 * returns no one else's), newest first, page by page, with unread ones
 * marked. Opening one marks it read and goes to what it is about.
 */
export function NotificationsScreen({ navigation }: Props) {
  const styles = useStyles();
  const { notifications } = useServices();
  const [view, setView] = useState<NotificationView>('all');
  const loadCount = useCallback(() => notifications.unreadCount(), [notifications]);
  const unread = useAsync(loadCount);
  const count = unread.status === 'success' ? unread.data : 0;
  const [markingAll, setMarkingAll] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; message: string } | null>(null);
  const [version, setVersion] = useState(0);

  const markAll = useCallback(async () => {
    setMarkingAll(true);
    setNotice(null);
    try {
      const changed = await notifications.markAllRead();
      setNotice({
        tone: 'success',
        message:
          changed === 1 ? '1 notification marked as read.' : `${changed} notifications marked as read.`,
      });
      setVersion((v) => v + 1);
    } catch (error) {
      setNotice({ tone: 'danger', message: errorMessage(error) });
    } finally {
      setMarkingAll(false);
      unread.reload();
    }
  }, [notifications, unread]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Button
          title="Mark all read"
          variant="ghost"
          fullWidth={false}
          loading={markingAll}
          disabled={count === 0}
          onPress={() => void markAll()}
        />
      ),
    });
  }, [navigation, count, markingAll, markAll]);

  return (
    <View style={styles.container} testID="notifications-screen">
      <View style={styles.tabs} accessibilityRole="tablist">
        {VIEWS.map((v) => (
          <Pressable
            key={v.view}
            accessibilityRole="tab"
            accessibilityLabel={v.view === 'unread' && count > 0 ? `${v.label}, ${count}` : v.label}
            accessibilityState={{ selected: v.view === view }}
            onPress={() => setView(v.view)}
            style={[styles.tab, v.view === view && styles.tabSelected]}
          >
            <Text variant="label" tone={v.view === view ? 'default' : 'muted'}>
              {v.label}
              {v.view === 'unread' && count > 0 ? ` (${count})` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      {notice ? (
        <View style={styles.notice}>
          <Banner tone={notice.tone} message={notice.message} testID="notifications-notice" />
        </View>
      ) : null}
      <NotificationList
        key={`${view}:${version}`}
        view={view}
        empty={VIEWS.find((v) => v.view === view)!.empty}
        onChanged={unread.reload}
        onNotice={setNotice}
      />
    </View>
  );
}

function NotificationList({
  view,
  empty,
  onChanged,
  onNotice,
}: {
  view: NotificationView;
  empty: string;
  onChanged(): void;
  onNotice(notice: { tone: 'danger' | 'success'; message: string } | null): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const list = useNotificationList(view);
  const open = useOpenNotification();
  const { communities } = useCurrentCommunity();
  const names = new Map(communities.map((c) => [c.community_id, c.name]));
  const busy = useRef(false);

  // Back from a destination or a detail: show the server's current state.
  const { refresh } = list;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        void refresh();
        onChanged();
      }
    }, [refresh, onChanged]),
  );

  const press = async (n: Notification) => {
    if (busy.current) return;
    busy.current = true;
    onNotice(null);
    try {
      const result = await open(n);
      list.setRead([n.id], true);
      onChanged();
      if (!result.opened && result.reason === 'no-access')
        onNotice({ tone: 'danger', message: result.message! });
      // Nothing to open (e.g. a message from CommuniOne): show it in full.
      if (!result.opened && result.reason === 'no-target')
        navigation.navigate('NotificationDetail', { notificationId: n.id });
    } finally {
      busy.current = false;
    }
  };

  if (list.status === 'loading') return <LoadingState label="Loading notifications…" />;
  if (list.status === 'error' && list.items.length === 0) {
    return (
      <ErrorState
        title="Notifications could not be loaded"
        message={errorMessage(list.error)}
        onRetry={list.retry}
      />
    );
  }
  return (
    <FlatList
      testID="notifications-list"
      data={list.items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <NotificationItem
          notification={item}
          communityName={item.community_id ? (names.get(item.community_id) ?? null) : null}
          onPress={() => void press(item)}
        />
      )}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => {
            void list.refresh();
            onChanged();
          }}
          tintColor={colors.primary}
        />
      }
      contentContainerStyle={styles.list}
      ListEmptyComponent={<EmptyState icon="notifications-outline" title={empty} />}
      ListFooterComponent={
        <View style={styles.footer}>
          {list.error ? (
            <Text tone="danger" accessibilityRole="alert">
              {errorMessage(list.error)}
            </Text>
          ) : null}
          {list.hasMore ? (
            <Button
              title="Load more notifications"
              variant="ghost"
              loading={list.loadingMore}
              onPress={list.loadMore}
            />
          ) : null}
        </View>
      }
    />
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  tabs: {
    flexDirection: 'row',
    gap: t.spacing.lg,
    paddingHorizontal: t.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  tab: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabSelected: { borderBottomColor: t.colors.text },
  notice: { padding: t.spacing.lg, paddingBottom: 0 },
  list: { flexGrow: 1 },
  footer: { alignItems: 'center', gap: t.spacing.sm, padding: t.spacing.md },
}));

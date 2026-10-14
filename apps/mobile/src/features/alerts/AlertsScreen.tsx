import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { AlertCard } from './AlertCard';
import { canCreate, canSeeDrafts } from './alertRules';
import { useAlertList, type AlertView } from './useAlertList';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Alerts'>;

const VIEWS: { view: AlertView; label: string; empty: string; message?: string }[] = [
  { view: 'active', label: 'Active', empty: 'No active alerts.', message: 'All clear right now.' },
  { view: 'history', label: 'History', empty: 'No alerts have been issued yet.' },
  { view: 'drafts', label: 'Drafts', empty: 'No drafts.' },
];

/**
 * The current community's alerts. Everyone sees active ones (emergencies
 * first) and the history; "Drafts" appears for alerts.create /
 * alerts.manage holders and "New" for alerts.create holders (display only:
 * the database decides what each user receives and may change).
 */
export function AlertsScreen({ navigation }: Props) {
  const styles = useStyles();
  const permissions = useCommunityPermissions();
  const canAuthor = canCreate(permissions.can);
  const drafts = canSeeDrafts(permissions.can);
  const [view, setView] = useState<AlertView>('active');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canAuthor
        ? () => (
            <Button
              title="New"
              variant="ghost"
              fullWidth={false}
              onPress={() => navigation.navigate('AlertEditor')}
              accessibilityLabel="New alert"
            />
          )
        : undefined,
    });
  }, [navigation, canAuthor]);

  const views = VIEWS.filter((v) => v.view !== 'drafts' || drafts);
  return (
    <View style={styles.container} testID="alerts-screen">
      {canAuthor ? (
        <View style={styles.quick}>
          <Button
            title="Send a quick alert"
            variant="danger"
            icon="megaphone-outline"
            onPress={() => navigation.navigate('QuickAlert')}
          />
        </View>
      ) : null}
      <View style={styles.tabs} accessibilityRole="tablist">
        {views.map((v) => (
          <Pressable
            key={v.view}
            accessibilityRole="tab"
            accessibilityLabel={v.label}
            accessibilityState={{ selected: v.view === view }}
            onPress={() => setView(v.view)}
            style={[styles.tab, v.view === view && styles.tabSelected]}
          >
            <Text variant="label" tone={v.view === view ? 'inverse' : 'default'}>
              {v.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <AlertList
        key={view}
        view={view}
        onOpen={(id) => navigation.navigate('AlertDetail', { alertId: id })}
      />
    </View>
  );
}

function AlertList({ view, onOpen }: { view: AlertView; onOpen(id: string): void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const list = useAlertList(community.community_id, view);
  const { empty, message } = VIEWS.find((v) => v.view === view)!;

  // Back from a detail or the editor: show the server's current state.
  const { refresh } = list;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else void refresh();
    }, [refresh]),
  );

  if (list.status === 'loading') return <LoadingState label="Loading alerts…" />;
  if (list.status === 'error' && list.items.length === 0) {
    return (
      <ErrorState
        title="Alerts could not be loaded"
        message={errorMessage(list.error)}
        onRetry={list.retry}
      />
    );
  }
  return (
    <FlatList
      data={list.items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => <AlertCard alert={item} onPress={() => onOpen(item.id)} />}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => void list.refresh()}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={<EmptyState icon="shield-checkmark-outline" title={empty} message={message} />}
      ListFooterComponent={
        <View style={styles.footer}>
          {list.error ? (
            <Text tone="danger" accessibilityRole="alert">
              {errorMessage(list.error)}
            </Text>
          ) : null}
          {list.hasMore ? (
            <Button
              title="Load more alerts"
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
  quick: { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md },
  container: { flex: 1, backgroundColor: t.colors.background },
  tabs: {
    flexDirection: 'row',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
  },
  tab: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  tabSelected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  list: { flexGrow: 1, gap: t.spacing.md, padding: t.spacing.lg },
  footer: { alignItems: 'center', gap: t.spacing.sm },
}));

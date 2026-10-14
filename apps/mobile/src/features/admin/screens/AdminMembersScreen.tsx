import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Member, MembershipStatus } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Avatar, Button, EmptyState, ErrorState, Icon, LoadingState, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { memberName, roleLine } from '@/features/members/memberRules';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { canManageMembers, memberTabs } from '../adminRules';
import { useMembershipList } from '../useMembershipList';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AdminMembers'>;

const EMPTY: Record<string, { title: string; message?: string }> = {
  active: { title: 'No members yet' },
  pending: {
    title: 'No requests',
    message: 'People who join with an invitation are admitted at once, so requests are rare.',
  },
  suspended: { title: 'Nobody is suspended' },
};

/**
 * Member management (RN-16): active members, join requests and suspended
 * members, each tab shown only with a permission that may act on it. Rows
 * open AdminMember, where the actions are.
 */
export function AdminMembersScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const permissions = useCommunityPermissions();
  const tabs = memberTabs(permissions.can);
  const [status, setStatus] = useState<MembershipStatus>(
    tabs.some((t) => t.status === route.params?.status) ? route.params!.status! : 'active',
  );

  if (!canManageMembers(permissions.can)) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Not available"
        message="You don't have permission to manage members here."
      />
    );
  }

  return (
    <View style={styles.container} testID="admin-members-screen">
      <View style={styles.tabs} accessibilityRole="tablist">
        {tabs.map((t) => (
          <Pressable
            key={t.status}
            accessibilityRole="tab"
            accessibilityState={{ selected: t.status === status }}
            accessibilityLabel={t.label}
            onPress={() => setStatus(t.status)}
            style={[styles.tab, t.status === status && styles.tabSelected]}
          >
            <Text variant="label" tone={t.status === status ? 'default' : 'muted'}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {/* A new list per tab: rows of one status never leak into another. */}
      <MembershipList
        key={status}
        status={status}
        onOpen={(m) => navigation.navigate('AdminMember', { membershipId: m.id })}
      />
    </View>
  );
}

function MembershipList({ status, onOpen }: { status: MembershipStatus; onOpen(member: Member): void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const { session } = useAuth();
  const list = useMembershipList(community.community_id, status);

  // Back from a member: the server's current list (they may have moved tab).
  const { refresh } = list;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else void refresh();
    }, [refresh]),
  );

  if (list.status === 'loading') return <LoadingState label="Loading members…" />;
  if (list.status === 'error' && list.items.length === 0) {
    return (
      <ErrorState
        title="Members could not be loaded"
        message={errorMessage(list.error)}
        onRetry={list.retry}
      />
    );
  }
  return (
    <FlatList
      testID="admin-members-list"
      data={list.items}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => {
        const name = memberName(item);
        const roles = roleLine(item.roles.map((r) => r.name));
        const me = item.userId === session?.user.id;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[name, me ? 'You' : null, roles].filter(Boolean).join('. ')}
            onPress={() => onOpen(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`admin-member-${item.id}`}
          >
            <Avatar uri={item.avatarUrl} name={name} size={44} label="" />
            <View style={styles.flex}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {me ? `${name} (you)` : name}
              </Text>
              {roles ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {roles}
                </Text>
              ) : null}
            </View>
            <Icon name="chevron-forward" size={18} color="textMuted" />
          </Pressable>
        );
      }}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => void list.refresh()}
          tintColor={colors.primary}
        />
      }
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <EmptyState icon="people-outline" title={EMPTY[status]!.title} message={EMPTY[status]!.message} />
      }
      ListFooterComponent={
        <View style={styles.footer}>
          {list.error ? (
            <Text tone="danger" accessibilityRole="alert">
              {errorMessage(list.error)}
            </Text>
          ) : null}
          {list.hasMore ? (
            <Button
              title="Load more members"
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
    gap: t.spacing.xs,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  tab: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
  },
  tabSelected: { backgroundColor: t.colors.surfaceMuted },
  list: { flexGrow: 1, paddingBottom: t.spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 64,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  flex: { flex: 1, gap: 2 },
  footer: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
}));

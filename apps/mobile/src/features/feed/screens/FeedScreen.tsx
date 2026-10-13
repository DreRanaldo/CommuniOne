import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ActiveAlert, FeedPost } from '@communione/services';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { displayNameOf, useMyProfile } from '@/features/profile/hooks/useMyProfile';
import { useStories } from '@/features/stories/useStories';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { FeedHeader } from '../components/FeedHeader';
import { PostCard } from '../components/PostCard';
import { useFeed, type FeedStatus } from '../useFeed';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Feed'>;

const FILTERS: { status: FeedStatus; label: string }[] = [
  { status: 'published', label: 'Latest' },
  { status: 'hidden', label: 'Hidden' },
  { status: 'deleted', label: 'Deleted' },
];

/** Urgent and emergency alerts stay visible above the feed. */
const PINNED_SEVERITIES = new Set(['urgent', 'emergency']);

/**
 * The Home tab: the current community's feed, photo first, newest first.
 * Controls are shown from the user's permissions (posts.create / edit_own /
 * delete_own / moderate) and from authorship, but only as hints: the database
 * authorizes every action and decides which posts are returned (hidden and
 * deleted posts reach only moderators and their own author).
 */
export function FeedScreen({ navigation }: Props) {
  const styles = useStyles();
  const { alerts } = useServices();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const canCreate = permissions.can('posts.create');
  const canModerate = permissions.can('posts.moderate');
  const profile = useMyProfile({ reloadOnFocus: true });
  const me =
    profile.status === 'success'
      ? { name: displayNameOf(profile.data.profile), avatarUri: profile.data.avatarUri }
      : { name: null, avatarUri: null };
  const firstName =
    profile.status === 'success'
      ? profile.data.profile.first_name?.trim() || me.name?.split(/\s+/)[0] || null
      : null;
  const stories = useStories(community.community_id);
  const reloadStories = stories.reload;
  const root = () => navigation.getParent()?.getParent();
  const [status, setStatus] = useState<FeedStatus>('published');

  // Urgent and emergency alerts in force, refreshed with the feed (never blocks it).
  const loadPinned = useCallback(async (): Promise<ActiveAlert[]> => {
    const page = await alerts.listActive({ communityId: community.community_id, limit: 5 });
    return page.items.filter(
      (a) => a.community_id === community.community_id && PINNED_SEVERITIES.has(a.severity),
    );
  }, [alerts, community.community_id]);
  const pinnedAlerts = useAsync(loadPinned);
  const { notifications } = useServices();
  const loadUnread = useCallback(() => notifications.unreadCount(), [notifications]);
  const unread = useAsync(loadUnread);
  const { reload: reloadUnread } = unread;
  const pinned = pinnedAlerts.status === 'success' ? pinnedAlerts.data : [];
  const { reload: reloadPinned } = pinnedAlerts;
  const loadAlerts = useCallback(async () => {
    reloadPinned();
    reloadUnread();
    reloadStories();
  }, [reloadPinned, reloadUnread, reloadStories]);

  // Members can see their own hidden posts; only moderators get a "Deleted" view.
  const filters = FILTERS.filter((f) => f.status !== 'deleted' || canModerate);
  const header = (
    <>
      <FeedHeader
        firstName={firstName}
        me={me}
        canCreate={canCreate}
        canCreateEvent={permissions.can('events.create')}
        canCreateAlert={permissions.can('alerts.create')}
        onCompose={() => navigation.navigate('PostEditor')}
        onAddPhotos={() => navigation.navigate('PostEditor', { addPhotos: true })}
        onNewEvent={() => navigation.navigate('EventEditor')}
        onNewAlert={() => navigation.navigate('AlertEditor')}
        stories={{
          groups: stories.groups,
          avatars: stories.avatars,
          onAdd: () => root()?.navigate('StoryComposer'),
          onOpen: (authorId) =>
            root()?.navigate('StoryViewer', { communityId: community.community_id, authorId }),
        }}
        alerts={pinned}
        unread={unread.status === 'success' ? unread.data : 0}
        onOpenNotifications={() => root()?.navigate('Notifications')}
        onOpenAlert={(alertId) => navigation.navigate('AlertDetail', { alertId })}
      />
      <View style={styles.filters} accessibilityRole="tablist">
        {filters.map((f) => (
          <Pressable
            key={f.status}
            accessibilityRole="tab"
            accessibilityState={{ selected: f.status === status }}
            accessibilityLabel={f.label}
            onPress={() => setStatus(f.status)}
            style={[styles.filter, f.status === status && styles.filterSelected]}
          >
            <Text variant="label" tone={f.status === status ? 'default' : 'muted'}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container} testID="feed-screen">
      {/* A new list per filter: no rows of one view leak into another. */}
      <FeedList
        key={status}
        status={status}
        header={header}
        canCreate={canCreate}
        onRefreshed={loadAlerts}
        onCompose={() => navigation.navigate('PostEditor')}
        onEdit={(postId) => navigation.navigate('PostEditor', { postId })}
        onOpen={(post) => navigation.navigate('PostDetail', { postId: post.id, post })}
        onOpenAuthor={(userId) => navigation.navigate('MemberProfile', { userId })}
      />
    </SafeAreaView>
  );
}

function FeedList({
  status,
  header,
  canCreate,
  onRefreshed,
  onCompose,
  onEdit,
  onOpen,
  onOpenAuthor,
}: {
  status: FeedStatus;
  header: ReactElement;
  canCreate: boolean;
  onRefreshed(): Promise<void>;
  onCompose(): void;
  onEdit(postId: string): void;
  onOpen(post: FeedPost): void;
  onOpenAuthor(userId: string): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { posts } = useServices();
  const community = useCommunity();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const feed = useFeed(community.community_id, status);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const viewerId = session?.user.id ?? null;
  const { width } = useWindowDimensions();
  const canModerate = permissions.can('posts.moderate');

  // Back from writing or editing a post: show the server's current feed.
  const { refresh } = feed;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        void refresh();
        void onRefreshed();
      }
    }, [refresh, onRefreshed]),
  );

  const failed = (postId: string, error: unknown) =>
    setErrors((e) => ({ ...e, [postId]: errorMessage(error) }));
  const cleared = (postId: string) => setErrors(({ [postId]: _removed, ...rest }) => rest);

  const actionsFor = (post: FeedPost) => {
    // Display hints only: the database checks authorship and permissions.
    const own = viewerId !== null && post.author_user_id === viewerId;
    return {
      onEdit:
        own && post.status === 'published' && permissions.can('posts.edit_own')
          ? () => onEdit(post.id)
          : undefined,
      onDelete:
        own && post.status !== 'deleted' && permissions.can('posts.delete_own')
          ? async () => {
              cleared(post.id);
              try {
                await posts.delete(post.id);
                feed.remove(post.id);
              } catch (error) {
                failed(post.id, error);
              }
            }
          : undefined,
      onHide: canModerate
        ? async (reason: string) => {
            cleared(post.id);
            try {
              await posts.hide(post.id, reason.trim() || undefined);
              // No longer in this view (published); it moves to "Hidden".
              feed.remove(post.id);
            } catch (error) {
              failed(post.id, error);
              void feed.refresh();
            }
          }
        : undefined,
      onRestore: canModerate
        ? async () => {
            cleared(post.id);
            try {
              await posts.restore(post.id);
              feed.remove(post.id);
            } catch (error) {
              failed(post.id, error);
              void feed.refresh();
            }
          }
        : undefined,
      onOpenComments: post.status === 'published' ? () => onOpen(post) : undefined,
      onReactionRejected: () => void feed.refresh(),
    };
  };

  if (feed.status === 'loading') {
    return (
      <View style={styles.flex}>
        {header}
        <LoadingState label="Loading posts…" />
      </View>
    );
  }
  if (feed.status === 'error') {
    return (
      <View style={styles.flex}>
        {header}
        <ErrorState
          title="Posts could not be loaded"
          message={errorMessage(feed.error)}
          onRetry={feed.retry}
        />
      </View>
    );
  }

  return (
    <FlatList
      testID="feed-list"
      data={feed.items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={header}
      renderItem={({ item }) => (
        <PostCard
          post={item}
          images={feed.images[item.id]}
          avatarUrl={item.author_user_id ? (feed.avatars[item.author_user_id] ?? null) : null}
          galleryWidth={width}
          communityName={community.name}
          onOpenAuthor={item.author_user_id ? () => onOpenAuthor(item.author_user_id!) : undefined}
          reactionCounts={feed.reactionCounts[item.id] ?? null}
          error={errors[item.id]}
          {...actionsFor(item)}
        />
      )}
      onEndReached={feed.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={feed.refreshing}
          onRefresh={() => {
            void feed.refresh();
            void onRefreshed();
          }}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        status === 'published' ? (
          <EmptyState
            icon="chatbubbles-outline"
            title="No posts yet"
            message={
              canCreate ? 'Start the conversation in your community.' : 'Posts from members will appear here.'
            }
            action={canCreate ? { title: 'Write the first post', onPress: onCompose } : undefined}
          />
        ) : (
          <EmptyState
            icon={status === 'hidden' ? 'eye-off-outline' : 'trash-outline'}
            title={status === 'hidden' ? 'No hidden posts' : 'No deleted posts'}
          />
        )
      }
      ListFooterComponent={
        feed.moreError ? (
          <View style={styles.footer}>
            <Text tone="danger" accessibilityRole="alert">
              {errorMessage(feed.moreError)}
            </Text>
            <Button
              title="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={feed.hasMore ? feed.loadMore : () => void feed.refresh()}
            />
          </View>
        ) : feed.loadingMore ? (
          <View
            style={styles.footer}
            accessibilityRole="progressbar"
            accessibilityLabel="Loading more posts…"
          >
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : feed.hasMore ? (
          // Scrolling loads the next page automatically; the button is the accessible way.
          <Button title="Load more posts" variant="ghost" onPress={feed.loadMore} />
        ) : feed.items.length > 0 ? (
          <Text tone="muted" align="center" style={styles.end}>
            {"You're all caught up."}
          </Text>
        ) : null
      }
    />
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  flex: { flex: 1 },
  filters: {
    flexDirection: 'row',
    gap: t.spacing.xs,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  filter: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
  },
  filterSelected: { backgroundColor: t.colors.surfaceMuted },
  list: { flexGrow: 1, paddingBottom: t.spacing.xl },
  footer: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
  end: { paddingVertical: t.spacing.md },
}));

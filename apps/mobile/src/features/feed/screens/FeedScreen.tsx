import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { FeedPost } from '@communione/services';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { AlertCard } from '@/features/alerts/AlertCard';
import { AnnouncementItem } from '@/features/announcements/AnnouncementItem';
import { EventItem } from '@/features/events/EventItem';
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
import { mergeTimeline, NO_EXTRAS, type TimelineExtras, type TimelineItem } from '../timeline';
import { useFeed, type FeedStatus } from '../useFeed';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Feed'>;

/** Urgent and emergency alerts stay visible above the feed. */
const PINNED_SEVERITIES = new Set(['urgent', 'emergency']);

/** How many of each kind join the timeline (the full lists are in the hub). */
export const TIMELINE_LIMITS = { alerts: 20, announcements: 10, events: 10 } as const;

/**
 * The Home tab: the current community's feed, newest first: posts, with
 * current announcements, upcoming events and active alerts placed among them
 * by when they were published (RN-16); urgent and emergency alerts stay
 * pinned above. Only published posts are shown here: reviewing hidden and
 * deleted posts is an admin tool (Moderation, posts.moderate).
 * Controls are shown from the user's permissions (posts.create / edit_own /
 * delete_own / moderate) and from authorship, but only as hints: the database
 * authorizes every action and decides which posts are returned.
 */
export function FeedScreen({ navigation }: Props) {
  const styles = useStyles();
  const { alerts } = useServices();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const canCreate = permissions.can('posts.create');
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
  const { announcements, events } = useServices();

  // Alerts in force (urgent ones pinned, the rest in the timeline), current
  // announcements and upcoming events, refreshed with the feed. A section
  // that fails is simply left out: it never blocks the posts.
  const loadHighlights = useCallback(async () => {
    const communityId = community.community_id;
    const settle = async <T extends { community_id: string }>(load: () => Promise<{ items: T[] }>) => {
      try {
        // Defence in depth: never show another community's item.
        return (await load()).items.filter((item) => item.community_id === communityId);
      } catch {
        return [];
      }
    };
    const [active, current, upcoming] = await Promise.all([
      settle(() => alerts.listActive({ communityId, limit: TIMELINE_LIMITS.alerts })),
      settle(() => announcements.listCurrent({ communityId, limit: TIMELINE_LIMITS.announcements })),
      settle(() => events.listUpcoming({ communityId, limit: TIMELINE_LIMITS.events })),
    ]);
    const pinned = active.filter((a) => PINNED_SEVERITIES.has(a.severity));
    const extras: TimelineExtras = {
      alerts: active.filter((a) => !PINNED_SEVERITIES.has(a.severity)),
      announcements: current,
      events: upcoming,
    };
    return { pinned, extras };
  }, [alerts, announcements, events, community.community_id]);
  const pinnedAlerts = useAsync(loadHighlights);
  const { notifications } = useServices();
  const loadUnread = useCallback(() => notifications.unreadCount(), [notifications]);
  const unread = useAsync(loadUnread);
  const { reload: reloadUnread } = unread;
  const pinned = pinnedAlerts.status === 'success' ? pinnedAlerts.data.pinned : [];
  const extras = pinnedAlerts.status === 'success' ? pinnedAlerts.data.extras : NO_EXTRAS;
  const { reload: reloadPinned } = pinnedAlerts;
  const loadAlerts = useCallback(async () => {
    reloadPinned();
    reloadUnread();
    reloadStories();
  }, [reloadPinned, reloadUnread, reloadStories]);

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
        onNewAlert={() => navigation.navigate('QuickAlert')}
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
      <View style={styles.filters}>
        <View style={[styles.filter, styles.filterSelected]}>
          <Text variant="label" accessibilityRole="header">
            Latest
          </Text>
        </View>
      </View>
    </>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container} testID="feed-screen">
      <FeedList
        status="published"
        header={header}
        extras={extras}
        canCreate={canCreate}
        onRefreshed={loadAlerts}
        onCompose={() => navigation.navigate('PostEditor')}
        onEdit={(postId) => navigation.navigate('PostEditor', { postId })}
        onOpen={(post) => navigation.navigate('PostDetail', { postId: post.id, post })}
        onOpenAuthor={(userId) => navigation.navigate('MemberProfile', { userId })}
        onOpenAnnouncement={(announcementId) => navigation.navigate('AnnouncementDetail', { announcementId })}
        onOpenEvent={(eventId) => navigation.navigate('EventDetail', { eventId })}
        onOpenAlert={(alertId) => navigation.navigate('AlertDetail', { alertId })}
      />
    </SafeAreaView>
  );
}

/**
 * One list of posts with a given status. The feed shows published posts with
 * the timeline extras; the admin Moderation screen reuses it for hidden and
 * deleted posts (which the database returns only to moderators and authors).
 */
export function FeedList({
  status,
  header,
  extras = NO_EXTRAS,
  canCreate,
  onRefreshed,
  onCompose,
  onEdit,
  onOpen,
  onOpenAuthor,
  onOpenAnnouncement,
  onOpenEvent,
  onOpenAlert,
}: {
  status: FeedStatus;
  header: ReactElement;
  extras?: TimelineExtras;
  canCreate: boolean;
  onRefreshed(): Promise<void>;
  onCompose(): void;
  onEdit(postId: string): void;
  onOpen(post: FeedPost): void;
  onOpenAuthor(userId: string): void;
  onOpenAnnouncement?(announcementId: string): void;
  onOpenEvent?(eventId: string): void;
  onOpenAlert?(alertId: string): void;
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
  const timeline = useMemo(
    () =>
      mergeTimeline(
        feed.items,
        status === 'published' ? extras : NO_EXTRAS,
        feed.status !== 'ready' || feed.hasMore,
      ),
    [feed.items, feed.status, feed.hasMore, extras, status],
  );

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

  const renderTimelineItem = (item: TimelineItem) => {
    if (item.kind === 'announcement')
      return (
        <View style={styles.extra} testID={`feed-${item.key}`}>
          <AnnouncementItem
            announcement={item.announcement}
            compact
            onPress={onOpenAnnouncement ? () => onOpenAnnouncement(item.announcement.id) : undefined}
          />
        </View>
      );
    if (item.kind === 'event')
      return (
        <View style={styles.extra} testID={`feed-${item.key}`}>
          <EventItem
            event={item.event}
            onPress={onOpenEvent ? () => onOpenEvent(item.event.id) : undefined}
          />
        </View>
      );
    if (item.kind === 'alert')
      return (
        <View style={styles.extra} testID={`feed-${item.key}`}>
          <AlertCard
            alert={item.alert}
            compact
            onPress={onOpenAlert ? () => onOpenAlert(item.alert.id) : undefined}
          />
        </View>
      );
    const post = item.post;
    return (
      <PostCard
        post={post}
        images={feed.images[post.id]}
        avatarUrl={post.author_user_id ? (feed.avatars[post.author_user_id] ?? null) : null}
        galleryWidth={width}
        communityName={community.name}
        onOpenAuthor={post.author_user_id ? () => onOpenAuthor(post.author_user_id!) : undefined}
        reactionCounts={feed.reactionCounts[post.id] ?? null}
        error={errors[post.id]}
        {...actionsFor(post)}
      />
    );
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
      data={timeline}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.list}
      ListHeaderComponent={header}
      renderItem={({ item }) => renderTimelineItem(item)}
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
  extra: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
}));

import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { FeedPost } from '@communione/services';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { PostCard } from '../components/PostCard';
import { useFeed, type FeedStatus } from '../useFeed';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Feed'>;

const FILTERS: { status: FeedStatus; label: string }[] = [
  { status: 'published', label: 'Posts' },
  { status: 'hidden', label: 'Hidden' },
  { status: 'deleted', label: 'Deleted' },
];

/**
 * The current community's feed. Controls are shown from the user's
 * permissions (posts.create / edit_own / delete_own / moderate) and from
 * authorship, but only as hints: the database authorizes every action and
 * decides which posts are returned (hidden and deleted posts reach only
 * moderators and their own author).
 */
export function FeedScreen({ navigation }: Props) {
  const styles = useStyles();
  const permissions = useCommunityPermissions();
  const canCreate = permissions.can('posts.create');
  const canModerate = permissions.can('posts.moderate');
  const [status, setStatus] = useState<FeedStatus>('published');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canCreate
        ? () => (
            <Button
              title="New post"
              variant="ghost"
              fullWidth={false}
              onPress={() => navigation.navigate('PostEditor')}
            />
          )
        : undefined,
    });
  }, [navigation, canCreate]);

  // Members can see their own hidden posts; only moderators get a "Deleted" view.
  const filters = FILTERS.filter((f) => f.status !== 'deleted' || canModerate);

  return (
    <View style={styles.container} testID="feed-screen">
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
            <Text variant="label" tone={f.status === status ? 'inverse' : 'default'}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {/* A new list per filter: no rows of one view leak into another. */}
      <FeedList
        key={status}
        status={status}
        canCreate={canCreate}
        onCompose={() => navigation.navigate('PostEditor')}
        onEdit={(postId) => navigation.navigate('PostEditor', { postId })}
      />
    </View>
  );
}

function FeedList({
  status,
  canCreate,
  onCompose,
  onEdit,
}: {
  status: FeedStatus;
  canCreate: boolean;
  onCompose(): void;
  onEdit(postId: string): void;
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

  // Back from writing or editing a post: show the server's current feed.
  const { refresh } = feed;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else void refresh();
    }, [refresh]),
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
      onToggleLike:
        post.status === 'published'
          ? async () => {
              cleared(post.id);
              const liked = post.my_reaction_type !== null;
              try {
                if (liked) await posts.unreact({ postId: post.id });
                else await posts.react({ postId: post.id, type: 'like' });
                feed.update(post.id, {
                  // Generated types mark function columns non-null; this one is NULL without a reaction.
                  my_reaction_type: (liked ? null : 'like') as FeedPost['my_reaction_type'],
                  reaction_count: post.reaction_count + (liked ? -1 : 1),
                });
              } catch (error) {
                failed(post.id, error);
              }
            }
          : undefined,
    };
  };

  if (feed.status === 'loading') return <LoadingState label="Loading posts…" />;
  if (feed.status === 'error') {
    return (
      <ErrorState title="Posts could not be loaded" message={errorMessage(feed.error)} onRetry={feed.retry} />
    );
  }

  return (
    <FlatList
      testID="feed-list"
      data={feed.items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => <PostCard post={item} error={errors[item.id]} {...actionsFor(item)} />}
      onEndReached={feed.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={feed.refreshing}
          onRefresh={() => void feed.refresh()}
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
  filters: {
    flexDirection: 'row',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
  },
  filter: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  filterSelected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  list: { flexGrow: 1, gap: t.spacing.md, padding: t.spacing.lg },
  footer: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
  end: { paddingVertical: t.spacing.md },
}));

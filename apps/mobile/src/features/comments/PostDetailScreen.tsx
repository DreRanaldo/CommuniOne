import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type FeedPost } from '@communione/services';
import { useCallback, useMemo, useState } from 'react';
import { ErrorState, LoadingState, Screen, SectionHeader, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { PostCard } from '@/features/feed/components/PostCard';
import { countsFromSummary } from '@/features/reactions/reactions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { CommentComposer } from './CommentComposer';
import { CommentThread } from './CommentThread';
import { ThreadContext, type ThreadContextValue } from './ThreadContext';
import { useComments } from './useComments';

type Props = NativeStackScreenProps<CommunityStackParamList, 'PostDetail'>;

/**
 * A post with its comments. The feed's copy is shown at once, then the post
 * is re-read from the server: if it is no longer visible to the user (hidden,
 * deleted, other community), the screen says so instead of showing stale
 * content.
 */
export function PostDetailScreen({ route }: Props) {
  const { postId, post: snapshot } = route.params;
  const { posts } = useServices();
  const community = useCommunity();
  const load = useCallback(async () => {
    const post = await posts.get(postId);
    if (post.community_id !== community.community_id) throw new Error('not in this community');
    return post;
  }, [posts, postId, community.community_id]);
  const current = useAsync(load);

  if (current.status === 'loading' && !snapshot) return <LoadingState label="Loading the post…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This post is not available' : 'The post could not be loaded'}
        message={gone ? 'It may have been hidden or deleted.' : errorMessage(current.error)}
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  if (!snapshot && current.status !== 'success') return null;
  // The server's current text and status, with the feed's author and counts.
  const post: FeedPost = {
    ...(snapshot ?? ({} as FeedPost)),
    ...(current.status === 'success'
      ? {
          id: current.data.id,
          community_id: current.data.community_id,
          author_user_id: current.data.author_user_id as string,
          body: current.data.body,
          status: current.data.status,
          edited_at: current.data.edited_at as string,
          moderation_reason: current.data.moderation_reason as string,
        }
      : {}),
  };
  return <PostDetail post={post} verified={current.status === 'success'} onReload={current.reload} />;
}

function PostDetail({ post, verified, onReload }: { post: FeedPost; verified: boolean; onReload(): void }) {
  const { comments, posts, auth } = useServices();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const topLevel = useComments(post.id, null);
  // The user's name for their new comments (as the server will show it).
  const loadMe = useCallback(() => auth.getMyProfile(), [auth]);
  const me = useAsync(loadMe);
  const myName = me.status === 'success' ? (me.data.display_name ?? null) : null;
  // Per-type reaction counts for the post (one summary call).
  const loadCounts = useCallback(() => posts.reactionSummary({ postIds: [post.id] }), [posts, post.id]);
  const summary = useAsync(loadCounts);
  const reactionCounts =
    summary.status === 'success' ? (countsFromSummary(summary.data, 'post_id')[post.id] ?? {}) : null;
  const [countDelta, setCountDelta] = useState(0);
  const [postError, setPostError] = useState<string | null>(null);
  const postPublished = post.status === 'published';
  const canModerate = permissions.can('posts.moderate');

  const context = useMemo<ThreadContextValue>(
    () => ({
      postId: post.id,
      postPublished,
      viewerId: session?.user.id ?? null,
      can: permissions.can,
      onCountChange: (delta) => setCountDelta((d) => d + delta),
    }),
    [post.id, postPublished, session?.user.id, permissions.can],
  );

  const moderate = async (action: () => Promise<unknown>) => {
    setPostError(null);
    try {
      await action();
    } catch (error) {
      setPostError(errorMessage(error));
    }
    onReload();
  };

  return (
    <ThreadContext.Provider value={context}>
      <Screen testID="post-detail-screen">
        <PostCard
          post={{ ...post, comment_count: post.comment_count + countDelta }}
          error={postError}
          reactionCounts={reactionCounts}
          onReactionRejected={onReload}
          onHide={
            canModerate
              ? (reason) => moderate(() => posts.hide(post.id, reason.trim() || undefined))
              : undefined
          }
          onRestore={canModerate ? () => moderate(() => posts.restore(post.id)) : undefined}
        />
        <SectionHeader title="Comments" icon="chatbubbles-outline" />
        {!verified ? (
          <LoadingState label="Loading comments…" />
        ) : (
          <>
            <CommentThread parentCommentId={null} list={topLevel} />
            {postPublished && permissions.can('comments.create') ? (
              <CommentComposer
                label="Write a comment"
                testID="comment-composer"
                onSubmit={async (body) => {
                  const created = await comments.create({ postId: post.id, body });
                  setCountDelta((d) => d + 1);
                  // The server's row, with the fields the thread list adds (it is new: no replies or reactions).
                  topLevel.add({
                    ...created,
                    author_display_name: myName,
                    author_avatar_url: null,
                    reply_count: 0,
                    reaction_count: 0,
                    my_reaction_type: null,
                  } as unknown as Parameters<typeof topLevel.add>[0]);
                }}
              />
            ) : postPublished ? null : (
              <Text tone="muted">Comments are closed while this post is not published.</Text>
            )}
          </>
        )}
      </Screen>
    </ThreadContext.Provider>
  );
}

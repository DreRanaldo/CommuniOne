import type { FeedPost, PostImage } from '@communione/services';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar, Button, Card, Icon, Text } from '@/components';
import { ReactionBar } from '@/features/reactions/ReactionBar';
import { isReactionType, type ReactionType } from '@/features/reactions/reactions';
import { makeStyles } from '@/theme';
import { formatDateTime, formatRelative } from '@/utils/format';
import { ModerationControls } from './ModerationControls';
import { PostBody } from './PostBody';
import { PostImageGallery } from './PostImageGallery';

/** A deleted account's posts stay without a name (account-deletion policy). */
export const postAuthorName = (post: Pick<FeedPost, 'author_user_id' | 'author_display_name'>): string =>
  post.author_user_id === null ? 'Deleted User' : post.author_display_name?.trim() || 'Member';

export interface PostCardActions {
  /** Shown only for the viewer's own published post with posts.edit_own (the server re-checks). */
  onEdit?: () => void;
  /** Shown only for the viewer's own post with posts.delete_own (the server re-checks). */
  onDelete?: () => Promise<void>;
  /** Shown only with posts.moderate (the server re-checks). */
  onHide?: (reason: string) => Promise<void>;
  onRestore?: () => Promise<void>;
  /** Opens the post with its comments. */
  onOpenComments?: () => void;
  /** A reaction change was refused: refresh the post. */
  onReactionRejected?: (error: unknown) => void;
}

export interface PostCardProps extends PostCardActions {
  post: FeedPost;
  /** The post's photos, in order (signed URLs). */
  images?: PostImage[];
  /** The author's profile picture (signed URL), if any. */
  avatarUrl?: string | null;
  /** Width of the photo gallery (defaults to the screen width). */
  galleryWidth?: number;
  /** Per-type reaction counts (reaction summary), when loaded. */
  reactionCounts?: Partial<Record<ReactionType, number>> | null;
  /** A short summary (community hub): fewer lines, no actions. */
  compact?: boolean;
  /** An action failed: shown on the post. */
  error?: string | null;
  /** The community's name, shown under the author. */
  communityName?: string | null;
}

/**
 * One post in the feed: the author with their picture, community and time, a
 * "…" menu with only the actions the viewer may take, the text (hashtags
 * highlighted), the photos, Like and Comment, and a link to the comments.
 * Hidden or deleted posts (sent only to moderators and their author) say so.
 */
export function PostCard({
  post,
  images = [],
  avatarUrl = null,
  communityName = null,
  galleryWidth,
  reactionCounts,
  compact,
  error,
  onEdit,
  onDelete,
  onHide,
  onRestore,
  onOpenComments,
  onReactionRejected,
}: PostCardProps) {
  const styles = useStyles();
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const author = postAuthorName(post);
  const mine = isReactionType(post.my_reaction_type) ? post.my_reaction_type : null;
  const hasActions = !!(onEdit || onDelete || onHide || onRestore);
  const comments = `${post.comment_count} ${post.comment_count === 1 ? 'comment' : 'comments'}`;

  const remove = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (compact) {
    return (
      <Card testID={`post-${post.id}`}>
        <Text variant="label" numberOfLines={1}>
          {author}
        </Text>
        <Text variant="caption" tone="muted">
          {formatDateTime(post.created_at)}
          {post.edited_at ? ' · Edited' : ''}
        </Text>
        <Text numberOfLines={3}>{post.body}</Text>
        <View style={styles.row}>
          <Icon name="heart-outline" color="textMuted" size={16} />
          <Text variant="caption" tone="muted" accessibilityLabel={`${post.reaction_count} reactions`}>
            {post.reaction_count}
          </Text>
          <Icon name="chatbubble-outline" color="textMuted" size={16} />
          <Text variant="caption" tone="muted" accessibilityLabel={comments}>
            {post.comment_count}
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <View style={styles.post} testID={`post-${post.id}`}>
      <View style={styles.header}>
        <Avatar uri={avatarUrl} name={author} size={44} label={`${author}'s picture`} testID="post-author" />
        <View style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {author}
          </Text>
          <View style={styles.meta}>
            <Text
              variant="caption"
              tone="muted"
              numberOfLines={1}
              accessibilityLabel={`Posted ${formatDateTime(post.created_at)}${communityName ? ` in ${communityName}` : ''}`}
            >
              {[communityName, formatRelative(post.created_at), post.edited_at ? 'Edited' : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Icon name="people-outline" size={13} color="textMuted" />
          </View>
        </View>
        {hasActions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Post options"
            accessibilityState={{ expanded: menu }}
            onPress={() => {
              setMenu((open) => !open);
              setConfirming(false);
            }}
            hitSlop={10}
            style={styles.menuButton}
          >
            <Icon name="ellipsis-horizontal" size={22} color="text" />
          </Pressable>
        ) : null}
      </View>

      {menu ? (
        <View style={styles.menu} testID="post-menu">
          {onEdit && !confirming ? (
            <Button
              title="Edit"
              variant="ghost"
              fullWidth={false}
              onPress={onEdit}
              accessibilityLabel="Edit post"
            />
          ) : null}
          {onDelete && !confirming ? (
            <Button
              title="Delete"
              variant="ghost"
              fullWidth={false}
              onPress={() => setConfirming(true)}
              accessibilityLabel="Delete post"
            />
          ) : null}
          <ModerationControls kind="post" status={post.status} onHide={onHide} onRestore={onRestore} />
          {confirming ? (
            <View style={styles.confirm} testID="confirm-delete">
              <Text>Delete this post? It will no longer be visible to the community.</Text>
              <View style={styles.row}>
                <Button
                  title="Delete post"
                  variant="danger"
                  fullWidth={false}
                  loading={deleting}
                  onPress={() => void remove()}
                />
                <Button
                  title="Keep it"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirming(false)}
                />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {post.status !== 'published' ? (
        <View style={styles.moderation} testID="post-moderation">
          <Icon
            name={post.status === 'hidden' ? 'eye-off-outline' : 'trash-outline'}
            size={16}
            color="danger"
          />
          <Text variant="caption" tone="danger" style={styles.flex}>
            {post.status === 'hidden' ? 'Hidden by a moderator' : 'Deleted'}
            {post.moderation_reason ? `: ${post.moderation_reason}` : ''}
          </Text>
        </View>
      ) : null}

      <PostBody body={post.body} style={styles.caption} />
      {images.length > 0 ? <PostImageGallery images={images} author={author} width={galleryWidth} /> : null}

      <View style={styles.actions}>
        <ReactionBar
          target={{ postId: post.id }}
          initial={{ mine, total: post.reaction_count, counts: reactionCounts ?? null }}
          enabled={post.status === 'published'}
          onRejected={onReactionRejected}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={onOpenComments ? `${comments}. Open comments` : comments}
          disabled={!onOpenComments}
          onPress={onOpenComments}
          style={styles.commentButton}
          hitSlop={8}
        >
          <Icon name="chatbubble-outline" color="text" size={21} />
          <Text variant="label">Comment</Text>
          {post.comment_count > 0 ? (
            <Text variant="caption" tone="muted">
              {post.comment_count}
            </Text>
          ) : null}
        </Pressable>
      </View>

      {onOpenComments ? (
        <Pressable accessibilityRole="link" onPress={onOpenComments} hitSlop={6} style={styles.textLink}>
          <Text variant="caption" tone="muted">
            {post.comment_count === 0
              ? 'Add a comment'
              : post.comment_count === 1
                ? 'View 1 comment'
                : `View all ${post.comment_count} comments`}
          </Text>
        </Pressable>
      ) : null}

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert" style={styles.padded}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  post: {
    gap: t.spacing.sm,
    paddingVertical: t.spacing.md,
    backgroundColor: t.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, paddingHorizontal: t.spacing.lg },
  meta: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
  menuButton: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  menu: {
    marginHorizontal: t.spacing.lg,
    padding: t.spacing.sm,
    gap: t.spacing.xs,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surfaceMuted,
  },
  moderation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    paddingHorizontal: t.spacing.lg,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.spacing.md,
    paddingHorizontal: t.spacing.md,
    flexWrap: 'wrap',
  },
  commentButton: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, minHeight: 36 },
  caption: { paddingHorizontal: t.spacing.lg, fontSize: 16, lineHeight: 24 },
  textLink: { paddingHorizontal: t.spacing.lg, minHeight: 24, justifyContent: 'center' },
  confirm: { gap: t.spacing.sm },
  padded: { paddingHorizontal: t.spacing.lg },
}));

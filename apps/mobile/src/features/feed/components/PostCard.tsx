import type { FeedPost } from '@communione/services';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar, Button, Card, Icon, Text } from '@/components';
import { ReactionBar } from '@/features/reactions/ReactionBar';
import { isReactionType, type ReactionType } from '@/features/reactions/reactions';
import { makeStyles } from '@/theme';
import { formatDateTime } from '@/utils/format';
import { ModerationControls } from './ModerationControls';

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
  /** Per-type reaction counts (reaction summary), when loaded. */
  reactionCounts?: Partial<Record<ReactionType, number>> | null;
  /** A short summary (community home): fewer lines, no actions. */
  compact?: boolean;
  /** An action failed: shown on the card. */
  error?: string | null;
}

/**
 * One post: author, time, body, reactions, comment count, and its moderation
 * state when the server returned a hidden or deleted post (only moderators
 * and the author receive those, with the moderator's reason).
 */
export function PostCard({
  post,
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
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const author = postAuthorName(post);
  const mine = isReactionType(post.my_reaction_type) ? post.my_reaction_type : null;

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

  const comments = `${post.comment_count} ${post.comment_count === 1 ? 'comment' : 'comments'}`;

  return (
    <Card testID={`post-${post.id}`}>
      <View style={styles.row}>
        {compact ? null : (
          <Avatar uri={null} name={author} size={36} label={`${author}'s picture`} testID="post-author" />
        )}
        <View style={styles.flex}>
          <Text variant="label" numberOfLines={1}>
            {author}
          </Text>
          <Text variant="caption" tone="muted">
            {formatDateTime(post.created_at)}
            {post.edited_at ? ' · Edited' : ''}
          </Text>
        </View>
      </View>

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

      <Text numberOfLines={compact ? 3 : undefined}>{post.body}</Text>

      {compact ? (
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
      ) : (
        <>
          <ReactionBar
            target={{ postId: post.id }}
            initial={{ mine, total: post.reaction_count, counts: reactionCounts ?? null }}
            enabled={post.status === 'published'}
            onRejected={onReactionRejected}
          />
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={onOpenComments ? `${comments}. Open comments` : comments}
              disabled={!onOpenComments}
              onPress={onOpenComments}
              style={styles.counter}
              hitSlop={8}
            >
              <Icon name="chatbubble-outline" color="textMuted" size={18} />
              <Text variant="caption" tone="muted">
                {post.comment_count}
              </Text>
            </Pressable>
            <View style={styles.flex} />
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
          </View>
        </>
      )}

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
            <Button title="Keep it" variant="ghost" fullWidth={false} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
  flex: { flex: 1 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs, minHeight: 32 },
  moderation: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  confirm: { gap: t.spacing.sm },
}));

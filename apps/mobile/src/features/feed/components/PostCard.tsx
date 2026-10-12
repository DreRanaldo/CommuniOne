import type { FeedPost } from '@communione/services';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar, Button, Card, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatDateTime } from '@/utils/format';

/** A deleted account's posts stay without a name (account-deletion policy). */
export const postAuthorName = (post: Pick<FeedPost, 'author_user_id' | 'author_display_name'>): string =>
  post.author_user_id === null ? 'Deleted User' : post.author_display_name?.trim() || 'Member';

export interface PostCardActions {
  /** Shown only for the viewer's own published post with posts.edit_own (the server re-checks). */
  onEdit?: () => void;
  /** Shown only for the viewer's own post with posts.delete_own (the server re-checks). */
  onDelete?: () => Promise<void>;
  /** Like / unlike (react with "like" or remove the reaction). */
  onToggleLike?: () => Promise<void>;
}

export interface PostCardProps extends PostCardActions {
  post: FeedPost;
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
export function PostCard({ post, compact, error, onEdit, onDelete, onToggleLike }: PostCardProps) {
  const styles = useStyles();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'delete' | 'like' | null>(null);
  const author = postAuthorName(post);
  const liked = post.my_reaction_type !== null && post.my_reaction_type !== undefined;

  const run = async (kind: 'delete' | 'like', action?: () => Promise<void>) => {
    if (!action) return;
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

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

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${liked ? 'Unlike' : 'Like'}. ${post.reaction_count} ${post.reaction_count === 1 ? 'reaction' : 'reactions'}`}
          accessibilityState={{ selected: liked, disabled: !onToggleLike || busy !== null }}
          disabled={!onToggleLike || busy !== null || compact}
          onPress={() => void run('like', onToggleLike)}
          style={styles.counter}
          hitSlop={8}
        >
          <Icon name={liked ? 'heart' : 'heart-outline'} color={liked ? 'danger' : 'textMuted'} size={18} />
          <Text variant="caption" tone="muted">
            {post.reaction_count}
          </Text>
        </Pressable>
        <View
          style={styles.counter}
          accessible
          accessibilityLabel={`${post.comment_count} ${post.comment_count === 1 ? 'comment' : 'comments'}`}
        >
          <Icon name="chatbubble-outline" color="textMuted" size={18} />
          <Text variant="caption" tone="muted">
            {post.comment_count}
          </Text>
        </View>
        <View style={styles.flex} />
        {!compact && onEdit && !confirming ? (
          <Button
            title="Edit"
            variant="ghost"
            fullWidth={false}
            onPress={onEdit}
            accessibilityLabel="Edit post"
          />
        ) : null}
        {!compact && onDelete && !confirming ? (
          <Button
            title="Delete"
            variant="ghost"
            fullWidth={false}
            onPress={() => setConfirming(true)}
            accessibilityLabel="Delete post"
          />
        ) : null}
      </View>

      {confirming ? (
        <View style={styles.confirm} testID="confirm-delete">
          <Text>Delete this post? It will no longer be visible to the community.</Text>
          <View style={styles.row}>
            <Button
              title="Delete post"
              variant="danger"
              fullWidth={false}
              loading={busy === 'delete'}
              onPress={() => void run('delete', onDelete)}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs, minHeight: 32 },
  moderation: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  confirm: { gap: t.spacing.sm },
}));

import type { ThreadComment } from '@communione/services';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Text } from '@/components';
import { postAuthorName } from '@/features/feed/components/PostCard';
import { ModerationControls } from '@/features/feed/components/ModerationControls';
import { ReactionBar } from '@/features/reactions/ReactionBar';
import { isReactionType, type ReactionType } from '@/features/reactions/reactions';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import { errorMessage } from '@/utils/errors';
import { formatDateTime } from '@/utils/format';
import { CommentComposer } from './CommentComposer';
import { MAX_COMMENT_DEPTH, useThread } from './ThreadContext';
import { useComments } from './useComments';

/** The replies to one comment: their own paged list. */
function Replies({ parentCommentId }: { parentCommentId: string }) {
  const { postId } = useThread();
  const list = useComments(postId, parentCommentId);
  return <CommentThread parentCommentId={parentCommentId} list={list} />;
}

/** One level of the thread (comments or replies) with paging. */
export function CommentThread({
  parentCommentId,
  list,
}: {
  parentCommentId: string | null;
  list: ReturnType<typeof useComments>;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const what = parentCommentId ? 'replies' : 'comments';

  if (list.status === 'loading') {
    return (
      <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={`Loading ${what}…`}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (list.status === 'error') {
    return (
      <View style={styles.center}>
        <Text tone="danger" accessibilityRole="alert">
          {errorMessage(list.error)}
        </Text>
        <Button title="Try again" variant="secondary" fullWidth={false} onPress={list.reload} />
      </View>
    );
  }
  return (
    <View
      style={[styles.list, parentCommentId ? styles.replies : null]}
      testID={parentCommentId ? `replies-${parentCommentId}` : 'comments'}
    >
      {list.items.length === 0 && !parentCommentId ? <Text tone="muted">No comments yet.</Text> : null}
      {list.items.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          counts={list.reactionCounts[comment.id] ?? null}
          onChange={(change) => list.update(comment.id, change)}
          onRemoved={() => list.remove(comment.id)}
          onReload={list.reload}
        />
      ))}
      {list.moreError ? (
        <Text tone="danger" accessibilityRole="alert">
          {errorMessage(list.moreError)}
        </Text>
      ) : null}
      {list.hasMore ? (
        <Button
          title={`Load more ${what}`}
          variant="ghost"
          fullWidth={false}
          loading={list.loadingMore}
          onPress={list.loadMore}
        />
      ) : null}
    </View>
  );
}

function CommentItem({
  comment,
  counts,
  onChange,
  onRemoved,
  onReload,
}: {
  comment: ThreadComment;
  counts: Partial<Record<ReactionType, number>> | null;
  onChange(change: Partial<ThreadComment>): void;
  onRemoved(): void;
  onReload(): void;
}) {
  const styles = useStyles();
  const { comments } = useServices();
  const thread = useThread();
  const [mode, setMode] = useState<'view' | 'edit' | 'reply' | 'confirm-delete'>('view');
  const [showReplies, setShowReplies] = useState(false);
  const [repliesVersion, setRepliesVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const author = postAuthorName(comment);
  const published = comment.status === 'published';
  // Display hints only: the database checks authorship, permissions and status.
  const own = thread.viewerId !== null && comment.author_user_id === thread.viewerId;
  const canReply =
    published && thread.postPublished && thread.can('comments.create') && comment.depth < MAX_COMMENT_DEPTH;
  const canEdit = own && published && thread.can('comments.edit_own');
  const canDelete = own && comment.status !== 'deleted' && thread.can('comments.delete_own');
  const canModerate = thread.can('comments.moderate');
  const mine = isReactionType(comment.my_reaction_type) ? comment.my_reaction_type : null;

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (thrown) {
      setError(errorMessage(thrown));
      throw thrown;
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    attempt(async () => {
      await comments.delete(comment.id);
      thread.onCountChange(-1);
      // With replies, a placeholder keeps them reachable; otherwise it goes.
      if (comment.reply_count > 0) onChange({ status: 'deleted' });
      else onRemoved();
      setMode('view');
    }).catch(() => undefined);

  const moderate = (action: () => Promise<{ status: string }>) =>
    attempt(async () => {
      const updated = await action();
      onChange({ status: updated.status });
    }).catch(() => {
      // The comment may have changed meanwhile: show the server's version.
      onReload();
    });

  return (
    <View style={styles.comment} testID={`comment-${comment.id}`}>
      <View style={styles.row}>
        <Text variant="label" numberOfLines={1} style={styles.flex}>
          {author}
        </Text>
        <Text variant="caption" tone="muted">
          {formatDateTime(comment.created_at)}
          {comment.edited_at ? ' · Edited' : ''}
        </Text>
      </View>
      {!published ? (
        <Text variant="caption" tone="danger" testID="comment-moderation">
          {comment.status === 'hidden' ? 'Hidden by a moderator' : 'Comment deleted'}
        </Text>
      ) : null}

      {mode === 'edit' ? (
        <CommentComposer
          label="Edit your comment"
          submitTitle="Save"
          initial={comment.body}
          onCancel={() => setMode('view')}
          onSubmit={async (body) => {
            const updated = await comments.edit(comment.id, body);
            onChange({ body: updated.body, edited_at: updated.edited_at ?? comment.edited_at });
            setMode('view');
          }}
        />
      ) : comment.status === 'deleted' && !own && !canModerate ? null : (
        <Text>{comment.body}</Text>
      )}

      {published && thread.postPublished ? (
        <ReactionBar
          target={{ commentId: comment.id }}
          initial={{ mine, total: comment.reaction_count, counts }}
          enabled
          onRejected={onReload}
        />
      ) : null}

      {mode === 'view' ? (
        <View style={styles.row}>
          {canReply ? (
            <Button
              title="Reply"
              variant="ghost"
              fullWidth={false}
              onPress={() => setMode('reply')}
              accessibilityLabel={`Reply to ${author}`}
            />
          ) : null}
          {canEdit ? (
            <Button
              title="Edit"
              variant="ghost"
              fullWidth={false}
              onPress={() => setMode('edit')}
              accessibilityLabel="Edit comment"
            />
          ) : null}
          {canDelete ? (
            <Button
              title="Delete"
              variant="ghost"
              fullWidth={false}
              onPress={() => setMode('confirm-delete')}
              accessibilityLabel="Delete comment"
            />
          ) : null}
          {canModerate ? (
            <ModerationControls
              kind="comment"
              status={comment.status}
              onHide={(reason) => moderate(() => comments.hide(comment.id, reason.trim() || undefined))}
              onRestore={() => moderate(() => comments.restore(comment.id))}
            />
          ) : null}
        </View>
      ) : null}

      {mode === 'confirm-delete' ? (
        <View style={styles.confirm}>
          <Text>Delete this comment?</Text>
          <View style={styles.row}>
            <Button
              title="Delete comment"
              variant="danger"
              fullWidth={false}
              loading={busy}
              onPress={() => void remove()}
            />
            <Button
              title="Keep it"
              variant="ghost"
              fullWidth={false}
              onPress={() => setMode('view')}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}

      {mode === 'reply' ? (
        <CommentComposer
          label={`Reply to ${author}`}
          submitTitle="Reply"
          testID={`reply-to-${comment.id}`}
          onCancel={() => setMode('view')}
          onSubmit={async (body) => {
            await comments.create({ postId: thread.postId, body, parentCommentId: comment.id });
            thread.onCountChange(1);
            onChange({ reply_count: comment.reply_count + 1 });
            // Show the replies as the server now has them.
            setRepliesVersion((v) => v + 1);
            setShowReplies(true);
            setMode('view');
          }}
        />
      ) : null}

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {comment.reply_count > 0 ? (
        <Button
          title={
            showReplies
              ? 'Hide replies'
              : `View ${comment.reply_count} ${comment.reply_count === 1 ? 'reply' : 'replies'}`
          }
          variant="ghost"
          fullWidth={false}
          onPress={() => setShowReplies((s) => !s)}
        />
      ) : null}
      {showReplies ? <Replies key={repliesVersion} parentCommentId={comment.id} /> : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  list: { gap: t.spacing.md },
  replies: { paddingLeft: t.spacing.lg, borderLeftWidth: 2, borderLeftColor: t.colors.border },
  center: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
  comment: { gap: t.spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
  flex: { flex: 1 },
  confirm: { gap: t.spacing.sm },
}));

// One level of a post's comment thread (top-level comments, or the replies
// to one comment), oldest first, page by page through the
// list_post_comments() keyset cursor. The database decides which comments
// are returned: published ones to members who can see the post; hidden or
// deleted ones only to moderators (comments.moderate) and their author.
import type { ThreadComment } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { countsFromSummary, type ReactionType } from '@/features/reactions/reactions';
import { useServices } from '@/lib/dependencies';

export const COMMENT_PAGE_SIZE = 20;

export function useComments(postId: string, parentCommentId: string | null) {
  const { comments, posts } = useServices();
  const [items, setItems] = useState<ThreadComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [reactionCounts, setReactionCounts] = useState<Record<string, Partial<Record<ReactionType, number>>>>(
    {},
  );
  const generation = useRef(0);

  const page = useCallback(
    (from: string | null) =>
      comments.list({
        postId,
        parentCommentId: parentCommentId ?? undefined,
        limit: COMMENT_PAGE_SIZE,
        cursor: from,
      }),
    [comments, postId, parentCommentId],
  );

  /** Reaction counts for a page of comments in one call (failure: totals only). */
  const loadCounts = useCallback(
    (rows: ThreadComment[]) => {
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return;
      posts.reactionSummary({ commentIds: ids }).then(
        (summary) =>
          setReactionCounts((current) => ({
            ...current,
            ...Object.fromEntries(ids.map((id) => [id, {}])),
            ...countsFromSummary(summary, 'comment_id'),
          })),
        () => undefined,
      );
    },
    [posts],
  );

  useEffect(() => {
    const id = ++generation.current;
    page(null).then(
      (result) => {
        if (id !== generation.current) return;
        // Only this post's comments, at this level (defence in depth).
        const rows = result.items.filter(
          (row) => row.post_id === postId && row.parent_comment_id === parentCommentId,
        );
        setItems(rows);
        setCursor(result.nextCursor);
        setStatus('ready');
        loadCounts(rows);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setError(thrown);
        setStatus('error');
      },
    );
  }, [page, postId, parentCommentId, attempt, loadCounts]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const id = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    page(cursor).then(
      (result) => {
        if (id !== generation.current) return;
        const rows = result.items.filter(
          (row) => row.post_id === postId && row.parent_comment_id === parentCommentId,
        );
        setItems((current) => {
          const seen = new Set(current.map((row) => row.id));
          return [...current, ...rows.filter((row) => !seen.has(row.id))];
        });
        setCursor(result.nextCursor);
        setLoadingMore(false);
        loadCounts(rows);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setMoreError(thrown);
        setLoadingMore(false);
      },
    );
  }, [cursor, loadingMore, page, postId, parentCommentId, loadCounts]);

  return {
    status,
    items,
    error,
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    reactionCounts,
    loadMore,
    reload: useCallback(() => {
      setStatus('loading');
      setError(null);
      setItems([]);
      setCursor(null);
      setAttempt((n) => n + 1);
    }, []),
    /** A comment the server just created: it is the newest, so it goes last (once all pages are loaded). */
    add: useCallback(
      (row: ThreadComment) => {
        if (cursor === null) setItems((current) => [...current, row]);
      },
      [cursor],
    ),
    update: useCallback((commentId: string, change: Partial<ThreadComment>) => {
      setItems((current) => current.map((row) => (row.id === commentId ? { ...row, ...change } : row)));
    }, []),
    remove: useCallback((commentId: string) => {
      setItems((current) => current.filter((row) => row.id !== commentId));
    }, []),
  };
}

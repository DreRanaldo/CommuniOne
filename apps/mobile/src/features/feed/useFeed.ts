// One community's feed, page by page (services.posts.list → the
// list_community_posts() keyset cursor). Never loads the whole feed: the next
// page is requested only when the user reaches the end of the list.
//
// The community id comes from CurrentCommunityProvider. What each row may
// contain is decided by the database (RLS on posts): published posts for
// posts.view holders; hidden / deleted ones only for moderators and their
// own author. Rows of another community are dropped (defence in depth).
import type { FeedPost } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { countsFromSummary, type ReactionType } from '@/features/reactions/reactions';
import { useServices } from '@/lib/dependencies';
import { logger } from '@/lib/logger';

export const FEED_PAGE_SIZE = 20;
export type FeedStatus = 'published' | 'hidden' | 'deleted';

export interface FeedState {
  status: 'loading' | 'ready' | 'error';
  items: FeedPost[];
  error: unknown;
  /** More pages exist on the server. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Loading the next page failed (the items so far stay). */
  moreError: unknown;
  refreshing: boolean;
  /** Loads the next page (no-op while loading or at the end). */
  loadMore(): void;
  /** Reloads the first page (pull to refresh). */
  refresh(): Promise<void>;
  retry(): void;
  /** Applies a server-confirmed change to one post. */
  update(postId: string, change: Partial<FeedPost>): void;
  /** Removes a post the server confirmed deleted. */
  remove(postId: string): void;
  /** Per-type reaction counts by post id (one summary call per page; absent if it failed). */
  reactionCounts: Record<string, Partial<Record<ReactionType, number>>>;
}

export function useFeed(communityId: string, status: FeedStatus = 'published'): FeedState {
  const { posts } = useServices();
  const [items, setItems] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reactionCounts, setReactionCounts] = useState<Record<string, Partial<Record<ReactionType, number>>>>(
    {},
  );
  // Only the latest first-page request (or the page after it) may change the list.
  const generation = useRef(0);

  const ownRows = useCallback(
    (rows: FeedPost[]) => {
      const own = rows.filter((row) => row.community_id === communityId);
      if (own.length !== rows.length)
        logger.log('warn', 'feed.foreign_items_dropped', { count: rows.length - own.length });
      return own;
    },
    [communityId],
  );

  /** Reaction counts for a page of posts in one call; a failure only means totals without types. */
  const loadCounts = useCallback(
    (rows: FeedPost[], replace: boolean) => {
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) {
        if (replace) setReactionCounts({});
        return;
      }
      posts.reactionSummary({ postIds: ids }).then(
        (summary) => {
          // Posts without reactions have no rows: record them as empty.
          const counts = {
            ...Object.fromEntries(ids.map((id) => [id, {}])),
            ...countsFromSummary(summary, 'post_id'),
          };
          setReactionCounts((current) => (replace ? counts : { ...current, ...counts }));
        },
        () => undefined,
      );
    },
    [posts],
  );

  const firstPage = useCallback(
    () => posts.list({ communityId, status, limit: FEED_PAGE_SIZE }),
    [posts, communityId, status],
  );

  useEffect(() => {
    const id = ++generation.current;
    firstPage().then(
      (page) => {
        if (id !== generation.current) return;
        const rows = ownRows(page.items);
        setItems(rows);
        setCursor(page.nextCursor);
        setError(null);
        setState('ready');
        loadCounts(rows, true);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setError(thrown);
        setState('error');
      },
    );
  }, [firstPage, ownRows, attempt, loadCounts]);

  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setRefreshing(true);
    setMoreError(null);
    try {
      const page = await firstPage();
      if (id !== generation.current) return;
      const rows = ownRows(page.items);
      setItems(rows);
      setCursor(page.nextCursor);
      setError(null);
      setState('ready');
      loadCounts(rows, true);
    } catch (thrown) {
      if (id !== generation.current) return;
      // Keep what is shown; the error is reported where "load more" errors are.
      setMoreError(thrown);
    } finally {
      if (id === generation.current) setRefreshing(false);
    }
  }, [firstPage, ownRows, loadCounts]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || state !== 'ready') return;
    const id = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    posts.list({ communityId, status, limit: FEED_PAGE_SIZE, cursor }).then(
      (page) => {
        if (id !== generation.current) return;
        const rows = ownRows(page.items);
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...rows.filter((item) => !seen.has(item.id))];
        });
        loadCounts(rows, false);
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setMoreError(thrown);
        setLoadingMore(false);
      },
    );
  }, [cursor, loadingMore, state, posts, communityId, status, ownRows, loadCounts]);

  const retry = useCallback(() => {
    generation.current += 1;
    setState('loading');
    setError(null);
    setItems([]);
    setCursor(null);
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback((postId: string, change: Partial<FeedPost>) => {
    setItems((current) => current.map((item) => (item.id === postId ? { ...item, ...change } : item)));
  }, []);

  const remove = useCallback((postId: string) => {
    setItems((current) => current.filter((item) => item.id !== postId));
  }, []);

  return {
    status: state,
    items,
    error,
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    refreshing,
    loadMore,
    refresh,
    retry,
    update,
    remove,
    reactionCounts,
  };
}

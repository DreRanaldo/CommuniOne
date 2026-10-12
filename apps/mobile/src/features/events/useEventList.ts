// One view of the current community's events, page by page:
//   upcoming → list_events(from now, published + cancelled), soonest first
//              (cancelled ones stay visible, marked, so people learn of it)
//   past     → list_past_events() (completed, or ended), newest first
//   drafts   → list_events(['draft']) (RLS: managers all, organizers their own)
import type { CommunityEvent } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type EventView = 'upcoming' | 'past' | 'drafts';
export const EVENT_PAGE_SIZE = 20;

export function useEventList(communityId: string, view: EventView) {
  const { events } = useServices();
  const [items, setItems] = useState<CommunityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (from: string | null) => {
      const page =
        view === 'past'
          ? await events.listPast({ communityId, limit: EVENT_PAGE_SIZE, cursor: from })
          : await events.list({
              communityId,
              limit: EVENT_PAGE_SIZE,
              cursor: from,
              ...(view === 'drafts'
                ? { statuses: ['draft'] }
                : { statuses: ['published', 'cancelled'], from: new Date().toISOString() }),
            });
      // Only this community's rows (defence in depth).
      return {
        items: page.items.filter((row) => row.community_id === communityId),
        nextCursor: page.nextCursor,
      };
    },
    [events, communityId, view],
  );

  useEffect(() => {
    const id = ++generation.current;
    fetchPage(null).then(
      (page) => {
        if (id !== generation.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setError(thrown);
        setStatus('error');
      },
    );
  }, [fetchPage, attempt]);

  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setRefreshing(true);
    try {
      const page = await fetchPage(null);
      if (id !== generation.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
      setError(null);
    } catch (thrown) {
      if (id === generation.current) setError(thrown);
    } finally {
      if (id === generation.current) setRefreshing(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const id = generation.current;
    setLoadingMore(true);
    fetchPage(cursor).then(
      (page) => {
        if (id !== generation.current) return;
        setItems((current) => {
          const seen = new Set(current.map((row) => row.id));
          return [...current, ...page.items.filter((row) => !seen.has(row.id))];
        });
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setError(thrown);
        setLoadingMore(false);
      },
    );
  }, [cursor, loadingMore, fetchPage]);

  return {
    status,
    items,
    error,
    hasMore: cursor !== null,
    loadingMore,
    refreshing,
    refresh,
    loadMore,
    retry: useCallback(() => {
      setStatus('loading');
      setError(null);
      setAttempt((n) => n + 1);
    }, []),
  };
}

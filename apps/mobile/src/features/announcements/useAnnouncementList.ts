// One view of the current community's announcements, page by page:
//   current → list_current_announcements() (published, not expired; important first)
//   past    → list_announcement_history() (published incl. expired, and archived)
//   drafts  → list_announcement_history(['draft']) (RLS: managers all, authors their own)
import type { AnnouncementHistoryItem } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type AnnouncementView = 'current' | 'past' | 'drafts';
export const ANNOUNCEMENT_PAGE_SIZE = 20;

/** Rows of all three views (current rows lack the history-only fields). */
export type AnnouncementRowItem = Omit<AnnouncementHistoryItem, 'is_expired' | 'sort_at' | 'archived_at'> &
  Partial<Pick<AnnouncementHistoryItem, 'is_expired' | 'sort_at' | 'archived_at'>>;

export function useAnnouncementList(communityId: string, view: AnnouncementView) {
  const { announcements } = useServices();
  const [items, setItems] = useState<AnnouncementRowItem[]>([]);
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
        view === 'current'
          ? await announcements.listCurrent({ communityId, limit: ANNOUNCEMENT_PAGE_SIZE, cursor: from })
          : await announcements.listHistory({
              communityId,
              limit: ANNOUNCEMENT_PAGE_SIZE,
              cursor: from,
              statuses: view === 'drafts' ? ['draft'] : undefined,
            });
      // Only this community's rows (defence in depth).
      return {
        items: (page.items as AnnouncementRowItem[]).filter((row) => row.community_id === communityId),
        nextCursor: page.nextCursor,
      };
    },
    [announcements, communityId, view],
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

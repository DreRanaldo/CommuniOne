// One view of the current community's alerts, page by page:
//   active  → list_active_alerts() (published, not past their end; emergencies first)
//   history → list_alert_history() (issued alerts: active, ended, cancelled, archived; newest first)
//   drafts  → list_alert_history(['draft']) (RLS: managers all, creators their own)
import type { AlertHistoryItem } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type AlertView = 'active' | 'history' | 'drafts';
export const ALERT_PAGE_SIZE = 20;

/** Rows of all three views (active rows lack the history-only fields). */
export type AlertRowItem = Pick<
  AlertHistoryItem,
  | 'id'
  | 'community_id'
  | 'title'
  | 'body'
  | 'severity'
  | 'severity_rank'
  | 'is_emergency'
  | 'published_at'
  | 'expires_at'
> &
  Partial<
    Omit<
      AlertHistoryItem,
      | 'id'
      | 'community_id'
      | 'title'
      | 'body'
      | 'severity'
      | 'severity_rank'
      | 'is_emergency'
      | 'published_at'
      | 'expires_at'
    >
  > & {
    edited_at?: string | null;
  };

export function useAlertList(communityId: string, view: AlertView) {
  const { alerts } = useServices();
  const [items, setItems] = useState<AlertRowItem[]>([]);
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
        view === 'active'
          ? await alerts.listActive({ communityId, limit: ALERT_PAGE_SIZE, cursor: from })
          : await alerts.listHistory({
              communityId,
              limit: ALERT_PAGE_SIZE,
              cursor: from,
              statuses: view === 'drafts' ? ['draft'] : undefined,
            });
      // Only this community's rows (defence in depth).
      return {
        items: (page.items as AlertRowItem[]).filter((row) => row.community_id === communityId),
        nextCursor: page.nextCursor,
      };
    },
    [alerts, communityId, view],
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

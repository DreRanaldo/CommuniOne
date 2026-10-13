// The user's notifications, page by page (list_my_notifications: own rows
// only, newest first, keyset cursor). "Unread" asks the server for unread
// ones only. Read state changes are applied locally after the server confirms.
import type { Notification } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type NotificationView = 'all' | 'unread';
export const NOTIFICATION_PAGE_SIZE = 20;

export function useNotificationList(view: NotificationView) {
  const { notifications } = useServices();
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (from: string | null) => {
      const page = await notifications.list({
        limit: NOTIFICATION_PAGE_SIZE,
        cursor: from,
        unreadOnly: view === 'unread',
      });
      return {
        items: page.items,
        nextCursor: page.nextCursor,
      };
    },
    [notifications, view],
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

  /** Applies a server-confirmed read state to rows on screen. */
  const setRead = useCallback((ids: string[] | 'all', read: boolean) => {
    const at = read ? new Date().toISOString() : null;
    setItems((current) =>
      current.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read_at: at } : n)),
    );
  }, []);

  return {
    status,
    setRead,
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

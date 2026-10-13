// The current community's member directory, page by page, by name, for one
// search text (the server searches names only, inside this community).
import type { DirectoryMember } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export const MEMBER_PAGE_SIZE = 30;

export function useMemberDirectory(communityId: string, query: string) {
  const { memberships } = useServices();
  const [items, setItems] = useState<DirectoryMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    (from: string | null) =>
      memberships.directory({
        communityId,
        query: query.trim() || undefined,
        limit: MEMBER_PAGE_SIZE,
        cursor: from,
      }),
    [memberships, communityId, query],
  );

  useEffect(() => {
    const id = ++generation.current;
    fetchPage(null).then(
      (page) => {
        if (id !== generation.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
        setError(null);
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
          const seen = new Set(current.map((m) => m.userId));
          return [...current, ...page.items.filter((m) => !seen.has(m.userId))];
        });
        // A full page always carries a cursor; an empty one means the end.
        setCursor(page.items.length === 0 ? null : page.nextCursor);
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
      setAttempt((n) => n + 1);
    }, []),
  };
}

// Memberships of the current community with one status, page by page (oldest
// first). RLS decides what comes back: active members need members.view,
// other statuses a membership-management permission.
import type { Member, MembershipStatus } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export const MEMBERSHIP_PAGE_SIZE = 30;

export function useMembershipList(communityId: string, status: MembershipStatus) {
  const { memberships } = useServices();
  const [items, setItems] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    (from: string | null) =>
      memberships.list({ communityId, status, limit: MEMBERSHIP_PAGE_SIZE, cursor: from }),
    [memberships, communityId, status],
  );

  useEffect(() => {
    const id = ++generation.current;
    fetchPage(null).then(
      (page) => {
        if (id !== generation.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setState('ready');
        setError(null);
      },
      (thrown: unknown) => {
        if (id !== generation.current) return;
        setError(thrown);
        setState('error');
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
      setState('ready');
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
          const seen = new Set(current.map((m) => m.id));
          return [...current, ...page.items.filter((m) => !seen.has(m.id))];
        });
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
    status: state,
    items,
    error,
    hasMore: cursor !== null,
    loadingMore,
    refreshing,
    refresh,
    loadMore,
    retry: useCallback(() => {
      setState('loading');
      setAttempt((n) => n + 1);
    }, []),
  };
}

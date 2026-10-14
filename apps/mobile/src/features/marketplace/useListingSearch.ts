// Storefront results for one community and one set of filters, page by page.
// A new filter set starts a new search; stale answers are ignored.
import type { ListingCard, SearchInput } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type ListingFilters = Omit<SearchInput, 'communityId' | 'limit' | 'cursor'>;

export const MARKET_PAGE_SIZE = 24;

export function useListingSearch(communityId: string, filters: ListingFilters) {
  const { marketplace } = useServices();
  const [items, setItems] = useState<ListingCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const key = JSON.stringify(filters);

  const fetchPage = useCallback(
    (from: string | null) =>
      marketplace.search({
        communityId,
        ...(JSON.parse(key) as ListingFilters),
        limit: MARKET_PAGE_SIZE,
        cursor: from,
      }),
    [marketplace, communityId, key],
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
          const seen = new Set(current.map((l) => l.id));
          return [...current, ...page.items.filter((l) => !seen.has(l.id))];
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

  /** Optimistic favorite toggle on a loaded card (the screen calls the server). */
  const patch = useCallback((id: string, change: Partial<ListingCard>) => {
    setItems((current) => current.map((l) => (l.id === id ? { ...l, ...change } : l)));
  }, []);

  return {
    status,
    items,
    error,
    hasMore: cursor !== null,
    loadingMore,
    refreshing,
    refresh,
    loadMore,
    patch,
    retry: useCallback(() => {
      setStatus('loading');
      setAttempt((n) => n + 1);
    }, []),
  };
}

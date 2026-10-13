// One view of the current community's documents, page by page (newest first,
// list_documents through RLS):
//   folder  → the top level (no folder) or one folder's documents, active only
//   archived → archived documents (only managers can see them)
import type { Document } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';

export type DocumentView = 'active' | 'archived';
export const DOCUMENT_PAGE_SIZE = 20;

export function useDocumentList(communityId: string, folderId: string | null, view: DocumentView) {
  const { documents } = useServices();
  const [items, setItems] = useState<Document[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (from: string | null) => {
      const page = await documents.list({
        communityId,
        limit: DOCUMENT_PAGE_SIZE,
        cursor: from,
        ...(view === 'archived' ? { statuses: ['archived'] } : folderId ? { folderId } : { rootOnly: true }),
      });
      // Only this community's rows (defence in depth).
      return {
        items: page.items.filter((row) => row.community_id === communityId),
        nextCursor: page.nextCursor,
      };
    },
    [documents, communityId, folderId, view],
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

import { useCallback, useEffect, useMemo, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

type Settled<T> = Exclude<AsyncState<T>, { status: 'loading' }>;

/**
 * Runs an async loader and tracks loading, data and error. Pass a loader
 * memoised with useCallback; it runs again whenever its identity changes or
 * reload() is called. "Loading" is derived during render (a result only
 * counts for the request that produced it), so a stale result from an older
 * request, or one arriving after unmount, is never shown.
 *
 *   const load = useCallback(() => communities.listMine(), [communities]);
 *   const mine = useAsync(load);
 */
export function useAsync<T>(load: () => Promise<T>): AsyncState<T> & { reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ request: object; state: Settled<T> } | null>(null);

  // A new identity per request (new loader or reload).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` deliberately forces a new request
  const request = useMemo(() => ({ load }), [load, attempt]);

  useEffect(() => {
    let current = true;
    request.load().then(
      (data) => current && setResult({ request, state: { status: 'success', data } }),
      (error: unknown) => current && setResult({ request, state: { status: 'error', error } }),
    );
    return () => {
      current = false;
    };
  }, [request]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const state: AsyncState<T> = result && result.request === request ? result.state : { status: 'loading' };
  return { ...state, reload };
}

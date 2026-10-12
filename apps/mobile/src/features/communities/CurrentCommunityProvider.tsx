// The current community for the whole signed-in app.
//
// Screens read it with useCurrentCommunity() / useCommunity() instead of
// passing community ids around. The selection is ALWAYS one of the caller's
// own memberships as returned by the server (my_communities(), scoped to the
// session user):
//   - a stored selection (state restoration) is used only if it is still in
//     that list, active, in an active community;
//   - select(id) re-fetches the list from the server before accepting an id,
//     so an id from a link or a stale screen cannot be forced in;
//   - the list is re-checked when the switcher opens and when the app returns
//     to the foreground; a community the user lost access to is dropped with
//     a notice.
// None of this authorizes anything: RLS checks every community request on
// the server, whatever the app has selected.
import { ErrorCode, ServiceError, type MyCommunity } from '@communione/services';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { useServices } from '@/lib/dependencies';
import { secureStorage } from '@/lib/secureStorage';
import { resolveSelection, unavailableReason } from './selection';

export const CURRENT_COMMUNITY_KEY = 'communione.currentCommunity';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Re-check memberships at most this often when the app returns to the foreground. */
const REFRESH_INTERVAL_MS = 60_000;

export type CommunityNotice = { kind: 'lostAccess'; name: string | null };

export interface CurrentCommunityValue {
  /** idle: nobody is signed in. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: unknown;
  /** The caller's pending, active and suspended memberships (server data). */
  communities: MyCommunity[];
  /** The selected community; always one of `communities` and selectable. */
  current: MyCommunity | null;
  notice: CommunityNotice | null;
  clearNotice(): void;
  /**
   * Makes a community current after re-checking the caller's memberships on
   * the server. Throws FORBIDDEN (same message whether the community does not
   * exist or the user is not a member) or VALIDATION (malformed id).
   */
  select(communityId: string): Promise<MyCommunity>;
  /** Re-fetches memberships; drops the selection if access was lost. */
  refresh(): Promise<void>;
  /** Initial load failed: try again. */
  retry(): void;
}

interface Snapshot {
  userId: string;
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  communities: MyCommunity[];
  currentId: string | null;
}

const CurrentCommunityContext = createContext<CurrentCommunityValue | null>(null);

async function readStored(userId: string): Promise<string | null> {
  try {
    const raw = await secureStorage.getItem(CURRENT_COMMUNITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { userId: owner, communityId } = parsed as Record<string, unknown>;
    // Another account's selection on this device is ignored.
    return owner === userId && typeof communityId === 'string' && UUID.test(communityId) ? communityId : null;
  } catch {
    return null;
  }
}

async function writeStored(userId: string, communityId: string | null): Promise<void> {
  try {
    if (communityId)
      await secureStorage.setItem(CURRENT_COMMUNITY_KEY, JSON.stringify({ userId, communityId }));
    else await secureStorage.removeItem(CURRENT_COMMUNITY_KEY);
  } catch {
    // Not critical: the user picks again next time.
  }
}

export function CurrentCommunityProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  const { communities: service } = useServices();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [noticeState, setNoticeState] = useState<{ userId: string; notice: CommunityNotice } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Only the latest request may change the state.
  const generation = useRef(0);
  const lastRefresh = useRef(0);

  // The selection the latest server list produced (read by refresh / select).
  const selected = useRef<{ userId: string; currentId: string | null } | null>(null);

  // State for another (or no) user is never shown: derived, not reset in an effect.
  const own = snapshot && userId && snapshot.userId === userId ? snapshot : null;
  const notice = noticeState && userId && noticeState.userId === userId ? noticeState.notice : null;
  const selectedFor = (owner: string) =>
    selected.current?.userId === owner ? selected.current.currentId : null;

  /** Applies a fresh server list, keeping the selection only if it is still valid. */
  const apply = useCallback(
    (owner: string, list: MyCommunity[], preferredId: string | null, reportLoss: boolean) => {
      const nextId = resolveSelection(list, preferredId);
      if (reportLoss && preferredId && nextId !== preferredId) {
        const name = list.find((c) => c.community_id === preferredId)?.name ?? null;
        setNoticeState({ userId: owner, notice: { kind: 'lostAccess', name } });
      }
      selected.current = { userId: owner, currentId: nextId };
      setSnapshot({ userId: owner, status: 'ready', error: null, communities: list, currentId: nextId });
      void writeStored(owner, nextId);
      return nextId;
    },
    [],
  );

  // Initial load (and retry): memberships from the server + the stored selection.
  useEffect(() => {
    if (!userId) return;
    const request = ++generation.current;
    lastRefresh.current = Date.now();
    Promise.all([service.listMine(), readStored(userId)]).then(
      ([list, stored]) => {
        if (request !== generation.current) return;
        // A selection made meanwhile (e.g. from a link opened at start) wins over the stored one.
        const madeMeanwhile = selected.current?.userId === userId;
        apply(userId, list, madeMeanwhile ? selectedFor(userId) : stored, !madeMeanwhile);
      },
      (error: unknown) => {
        if (request !== generation.current) return;
        setSnapshot({ userId, status: 'error', error, communities: [], currentId: null });
      },
    );
  }, [userId, service, apply, attempt]);

  const refresh = useCallback(async () => {
    // Before the first load completes there is nothing to re-check (and the
    // stored selection must not be lost).
    if (!userId || selected.current?.userId !== userId) return;
    const request = ++generation.current;
    lastRefresh.current = Date.now();
    try {
      const list = await service.listMine();
      if (request === generation.current) apply(userId, list, selectedFor(userId), true);
    } catch {
      // Offline or a server problem: keep what is shown. Screens report their own errors,
      // and the database still refuses anything the user may no longer do.
    }
  }, [userId, service, apply]);

  const select = useCallback(
    async (communityId: string) => {
      if (!userId) throw new ServiceError(ErrorCode.Unauthenticated);
      if (typeof communityId !== 'string' || !UUID.test(communityId)) {
        throw new ServiceError(ErrorCode.Validation, 'That community link is not valid.', {
          field: 'communityId',
        });
      }
      const request = generation.current;
      const list = await service.listMine();
      const target = list.find((c) => c.community_id === communityId);
      const reason = target ? unavailableReason(target) : null;
      if (!target || reason) {
        // Keep the list fresh, but leave the current selection as it is (if still valid).
        const keep = selected.current?.userId === userId ? selectedFor(userId) : await readStored(userId);
        if (request === generation.current) apply(userId, list, keep, true);
        throw new ServiceError(
          ErrorCode.Forbidden,
          !target
            ? "You don't have access to that community."
            : `You can't open ${target.name} right now (${reason!.toLowerCase()}).`,
        );
      }
      // An explicit, server-confirmed choice always applies (also over an initial load still in flight).
      apply(userId, list, communityId, false);
      setNoticeState(null);
      return target;
    },
    [userId, service, apply],
  );

  // Re-check memberships when the app returns to the foreground.
  const ready = own?.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastRefresh.current > REFRESH_INTERVAL_MS) void refresh();
    });
    return () => subscription.remove();
  }, [ready, refresh]);

  const value = useMemo<CurrentCommunityValue>(() => {
    const communities = own?.communities ?? [];
    return {
      status: !userId ? 'idle' : (own?.status ?? 'loading'),
      error: own?.error ?? null,
      communities,
      current: communities.find((c) => c.community_id === own?.currentId) ?? null,
      notice,
      clearNotice: () => setNoticeState(null),
      select,
      refresh,
      retry: () => {
        setSnapshot(null);
        setAttempt((n) => n + 1);
      },
    };
  }, [own, userId, notice, select, refresh]);

  return <CurrentCommunityContext.Provider value={value}>{children}</CurrentCommunityContext.Provider>;
}

export function useCurrentCommunity(): CurrentCommunityValue {
  const value = useContext(CurrentCommunityContext);
  if (!value) throw new Error('CurrentCommunityProvider is missing');
  return value;
}

/** The current community, for screens that only exist inside one (the community stack). */
export function useCommunity(): MyCommunity {
  const { current } = useCurrentCommunity();
  if (!current) throw new Error('useCommunity is only available while a community is selected');
  return current;
}

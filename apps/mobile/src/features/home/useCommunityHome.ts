// Data for the community home: the community's details and four short
// sections, loaded in parallel from the community-scoped list functions.
//
// Scope: the community id comes from CurrentCommunityProvider (never from a
// route or user input). The database decides what the user may see (RLS /
// permission checks inside each list function). As a second line of
// defence, any row whose community_id is not the current community is
// dropped and logged, so the screen can never show another community's item.
import {
  ErrorCode,
  isServiceError,
  type ActiveAlert,
  type Community,
  type CommunityEvent,
  type CurrentAnnouncement,
  type FeedPost,
} from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';
import { logger } from '@/lib/logger';
import { isNetworkError } from '@/utils/errors';
import { useCurrentCommunity } from '../communities/CurrentCommunityProvider';

/** How many items each section shows (the home is a summary, not a feed). */
export const HOME_LIMITS = { alerts: 5, announcements: 3, events: 3, posts: 3 } as const;

export type SectionResult<T> = { items: T[]; error?: undefined } | { items?: undefined; error: unknown };

export interface CommunityHomeData {
  /** Details not in the membership list (description, cover); null if unavailable. */
  details: Community | null;
  alerts: SectionResult<ActiveAlert>;
  announcements: SectionResult<CurrentAnnouncement>;
  events: SectionResult<CommunityEvent>;
  posts: SectionResult<FeedPost>;
  loadedAt: number;
}

export interface CommunityHomeState {
  status: 'loading' | 'ready' | 'error';
  data: CommunityHomeData | null;
  /** Everything failed on the first load. */
  error: unknown;
  /** The last refresh could not reach the server (the data shown is from `loadedAt`). */
  offline: boolean;
  refreshing: boolean;
  refresh(): Promise<void>;
  retry(): void;
}

const SECTIONS = ['alerts', 'announcements', 'events', 'posts'] as const;

export function useCommunityHome(communityId: string): CommunityHomeState {
  const services = useServices();
  const { refresh: refreshMemberships } = useCurrentCommunity();
  const [data, setData] = useState<CommunityHomeData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);

  const fetchAll = useCallback(async (): Promise<CommunityHomeData> => {
    const mine = <T extends { community_id: string }>(section: string, items: T[]): T[] => {
      const own = items.filter((item) => item.community_id === communityId);
      if (own.length !== items.length)
        logger.log('warn', 'home.foreign_items_dropped', { section, count: items.length - own.length });
      return own;
    };
    const settle = async <T extends { community_id: string }>(
      section: string,
      load: () => Promise<{ items: T[] }>,
    ): Promise<SectionResult<T>> => {
      try {
        return { items: mine(section, (await load()).items) };
      } catch (thrown) {
        return { error: thrown };
      }
    };
    const [details, alerts, announcements, events, posts] = await Promise.all([
      services.communities.get(communityId).then(
        (community) => (community.id === communityId ? community : null),
        (thrown: unknown) => {
          // NOT_FOUND: the community is no longer visible to this user (removed,
          // suspended, archived). Re-check memberships: the provider drops it.
          if (isServiceError(thrown) && thrown.code === ErrorCode.NotFound) void refreshMemberships();
          return thrown instanceof Error ? thrown : new Error('unavailable');
        },
      ),
      settle('alerts', () => services.alerts.listActive({ communityId, limit: HOME_LIMITS.alerts })),
      settle('announcements', () =>
        services.announcements.listCurrent({ communityId, limit: HOME_LIMITS.announcements }),
      ),
      settle('events', () => services.events.listUpcoming({ communityId, limit: HOME_LIMITS.events })),
      settle('posts', () => services.posts.list({ communityId, limit: HOME_LIMITS.posts })),
    ]);
    const result: CommunityHomeData = {
      details: details instanceof Error ? null : details,
      alerts,
      announcements,
      events,
      posts,
      loadedAt: Date.now(),
    };
    const failures = SECTIONS.map((s) => result[s].error).filter((e) => e !== undefined);
    // Nothing at all could be loaded: report it as one error.
    if (failures.length === SECTIONS.length && details instanceof Error) throw failures[0];
    return result;
  }, [services, communityId, refreshMemberships]);

  // First load (and retry after a full failure).
  useEffect(() => {
    const id = ++request.current;
    fetchAll().then(
      (loaded) => {
        if (id !== request.current) return;
        setData(loaded);
        setError(null);
        setOffline(SECTIONS.some((section) => isNetworkError(loaded[section].error)));
      },
      (thrown: unknown) => {
        if (id !== request.current) return;
        setError(thrown);
      },
    );
  }, [fetchAll, attempt]);

  /** Pull to refresh / return to the screen: keeps the current data on screen while loading. */
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setRefreshing(true);
    try {
      // Memberships first: if access was lost, the provider leaves this community.
      await refreshMemberships();
      const loaded = await fetchAll();
      if (id !== request.current) return;
      setData(loaded);
      setError(null);
      setOffline(SECTIONS.some((s) => isNetworkError(loaded[s].error)));
    } catch (thrown) {
      if (id !== request.current) return;
      if (isNetworkError(thrown)) setOffline(true);
      else setError(thrown);
    } finally {
      if (id === request.current) setRefreshing(false);
    }
  }, [fetchAll, refreshMemberships]);

  const retry = useCallback(() => {
    setError(null);
    setData(null);
    setAttempt((n) => n + 1);
  }, []);

  const status = data ? 'ready' : error ? 'error' : 'loading';
  return { status, data, error: data ? null : error, offline, refreshing, refresh, retry };
}

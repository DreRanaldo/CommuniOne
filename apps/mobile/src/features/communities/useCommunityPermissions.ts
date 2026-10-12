import { useCallback } from 'react';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { useCommunity } from './CurrentCommunityProvider';

/**
 * The user's permission keys in the current community
 * (my_community_permissions()). For showing or hiding controls ONLY: every
 * action is authorized again by the database, so a stale or wrong answer here
 * can hide a button but never grant anything.
 */
export function useCommunityPermissions() {
  const { communities } = useServices();
  const { community_id: communityId } = useCommunity();
  const load = useCallback(() => communities.myPermissions(communityId), [communities, communityId]);
  const state = useAsync(load);
  const keys = state.status === 'success' ? state.data : [];
  return {
    ready: state.status !== 'loading',
    can: (key: string) => keys.includes(key),
    reload: state.reload,
  };
}

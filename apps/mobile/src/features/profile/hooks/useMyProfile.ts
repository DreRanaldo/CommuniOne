import { useFocusEffect } from '@react-navigation/native';
import type { Profile } from '@communione/services';
import { useCallback, useRef } from 'react';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';

export interface MyProfile {
  profile: Profile;
  /** The caller's own private phone number; the backend never returns anyone else's. */
  phone: string | null;
  /** Signed URL (uploaded avatar) or external URL, or null. */
  avatarUri: string | null;
}

/**
 * The signed-in user's profile, private phone number and avatar URL. Every
 * call is scoped to the session's user by the service layer and RLS; there is
 * no user id parameter. With `reloadOnFocus` it reloads when the screen
 * regains focus (e.g. back from the edit screen).
 */
export function useMyProfile({ reloadOnFocus = false } = {}) {
  const { auth } = useServices();
  const load = useCallback(async (): Promise<MyProfile> => {
    const [profile, phone] = await Promise.all([auth.getMyProfile(), auth.getMyPhone()]);
    return { profile, phone, avatarUri: await auth.avatarUrl(profile) };
  }, [auth]);
  const state = useAsync(load);

  const { reload } = state;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else if (reloadOnFocus) reload();
    }, [reload, reloadOnFocus]),
  );
  return state;
}

export const displayNameOf = (profile: Profile): string | null =>
  profile.display_name?.trim() ||
  [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
  null;

// Authentication state for navigation: restores the stored session at start,
// then follows Supabase Auth events (sign-in, sign-out, token refresh,
// session revoked). The database independently validates every request.
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSupabase } from '@/lib/dependencies';
import { manageAutoRefresh } from '@/lib/supabase';

export type AuthState =
  | { status: 'restoring'; session: null }
  | { status: 'signedOut'; session: null }
  | { status: 'signedIn'; session: Session };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = useSupabase();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(
      ({ data }) => active && setSession((current) => (current === undefined ? data.session : current)),
      () => active && setSession(null),
    );
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next);
    });
    const stopAutoRefresh = manageAutoRefresh(supabase);
    return () => {
      active = false;
      data.subscription.unsubscribe();
      stopAutoRefresh();
    };
  }, [supabase]);

  const value = useMemo<AuthState>(() => {
    if (session === undefined) return { status: 'restoring', session: null };
    if (session === null) return { status: 'signedOut', session: null };
    return { status: 'signedIn', session };
  }, [session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing');
  return value;
}

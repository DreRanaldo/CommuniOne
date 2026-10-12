// Authentication state for the app, on top of Supabase Auth (the only auth
// system). It never authorizes anything: the database validates the session
// and checks permissions, memberships and tenant isolation on every request.
// This provider only decides which screens to show.
//
//   restoring ── stored session read from the keychain ──► signedIn / signedOut
//
// Sessions end in four ways, all ending in signedOut:
//   - the user signs out (no notice);
//   - Supabase cannot refresh the session (refresh token revoked or expired);
//   - Auth reports the session gone when it is checked (on start and when the
//     app returns to the foreground);
//   - any service call is refused as UNAUTHENTICATED (e.g. the session was
//     revoked on another device).
// The last three show "Your session has expired".
import type { Session } from '@supabase/supabase-js';
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
import { isAuthLink } from '@/constants/app';
import { useDependencies } from '@/lib/dependencies';
import { manageAutoRefresh } from '@/lib/supabase';
import { errorMessage } from '@/utils/errors';

export type AuthNotice =
  | { kind: 'sessionExpired' }
  | { kind: 'linkError'; message: string }
  | { kind: 'passwordUpdated' }
  | { kind: 'emailConfirmed' }
  | { kind: 'accountDeleted' };

export type AuthStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  /** Signed in through a password-reset link: a new password must be chosen first. */
  recovery: boolean;
  /** A message for the next auth screen (session expired, link problem, …). */
  notice: AuthNotice | null;
  /** True while an email link is being completed. */
  completingLink: boolean;
  signOut(): Promise<void>;
  /** Signs out every device (all sessions are revoked on the server). */
  signOutEverywhere(): Promise<void>;
  /** Deletes the account through the backend (delete_my_account) and signs out. */
  deleteAccount(): Promise<void>;
  /** Called after the new password is saved in recovery mode. */
  finishRecovery(): void;
  clearNotice(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Re-check the session with Auth at most this often when the app returns to the foreground. */
const VERIFY_INTERVAL_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const { supabase, services, links, sessionEvents } = useDependencies();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [completingLink, setCompletingLink] = useState(false);

  const signedIn = useRef(false);
  const intentionalSignOut = useRef(false);
  const lastVerified = useRef(0);

  // Session state from Supabase Auth.
  useEffect(() => {
    let active = true;
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        if (signedIn.current && !intentionalSignOut.current) setNotice({ kind: 'sessionExpired' });
        intentionalSignOut.current = false;
        setRecovery(false);
      }
      signedIn.current = next !== null;
      setSession(next);
    });
    supabase.auth.getSession().then(
      ({ data: stored }) => {
        if (!active) return;
        signedIn.current = stored.session !== null;
        setSession((current) => (current === undefined ? stored.session : current));
      },
      () => active && setSession((current) => (current === undefined ? null : current)),
    );
    const stopAutoRefresh = manageAutoRefresh(supabase);
    return () => {
      active = false;
      data.subscription.unsubscribe();
      stopAutoRefresh();
    };
  }, [supabase]);

  /**
   * Asks Auth whether the session is still valid. A revoked session is
   * cleared (supabase-js emits SIGNED_OUT); an unreachable server is not an
   * expiry, so the user stays signed in while offline.
   */
  const verifySession = useCallback(async () => {
    lastVerified.current = Date.now();
    const { error } = await supabase.auth.getUser();
    if (!error) return;
    const offline = error.name === 'AuthRetryableFetchError' || (error.status ?? 0) === 0;
    if (offline) return;
    const { data } = await supabase.auth.getSession();
    if (data.session) await supabase.auth.signOut({ scope: 'local' });
  }, [supabase]);

  // Check a restored session once at start, and again when returning to the foreground.
  const hasSession = session !== undefined && session !== null;
  useEffect(() => {
    if (!hasSession) return;
    void verifySession();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastVerified.current > VERIFY_INTERVAL_MS) void verifySession();
    });
    return () => subscription.remove();
  }, [hasSession, verifySession]);

  // The backend refused the session during normal use.
  useEffect(
    () =>
      sessionEvents.onExpired(() => {
        if (signedIn.current) void supabase.auth.signOut({ scope: 'local' });
      }),
    [sessionEvents, supabase],
  );

  // Email links: sign-up confirmation and password recovery.
  useEffect(() => {
    let active = true;
    const handle = async (url: string | null) => {
      if (!url || !isAuthLink(url)) return;
      setCompletingLink(true);
      try {
        const { kind } = await services.auth.handleAuthRedirect(url);
        if (!active) return;
        if (kind === 'recovery') setRecovery(true);
        setNotice(kind === 'signedIn' ? { kind: 'emailConfirmed' } : null);
      } catch (error) {
        if (active) setNotice({ kind: 'linkError', message: errorMessage(error) });
      } finally {
        if (active) setCompletingLink(false);
      }
    };
    void links.getInitialURL().then(handle);
    const unsubscribe = links.subscribe((url) => void handle(url));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [links, services]);

  const signOut = useCallback(async () => {
    intentionalSignOut.current = true;
    setNotice(null);
    try {
      await services.auth.signOut('local');
    } catch (error) {
      intentionalSignOut.current = false;
      throw error;
    }
  }, [services]);

  const signOutEverywhere = useCallback(async () => {
    intentionalSignOut.current = true;
    setNotice(null);
    try {
      await services.auth.signOut('global');
    } catch (error) {
      intentionalSignOut.current = false;
      throw error;
    }
  }, [services]);

  const deleteAccount = useCallback(async () => {
    intentionalSignOut.current = true;
    try {
      await services.auth.deleteMyAccount();
      setNotice({ kind: 'accountDeleted' });
    } catch (error) {
      intentionalSignOut.current = false;
      throw error;
    }
  }, [services]);

  const finishRecovery = useCallback(() => {
    setRecovery(false);
    setNotice({ kind: 'passwordUpdated' });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<AuthContextValue>(() => {
    const status: AuthStatus =
      session === undefined ? 'restoring' : session === null ? 'signedOut' : 'signedIn';
    return {
      status,
      session: session ?? null,
      recovery: status === 'signedIn' && recovery,
      notice,
      completingLink,
      signOut,
      signOutEverywhere,
      deleteAccount,
      finishRecovery,
      clearNotice,
    };
  }, [
    session,
    recovery,
    notice,
    completingLink,
    signOut,
    signOutEverywhere,
    deleteAccount,
    finishRecovery,
    clearNotice,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing');
  return value;
}

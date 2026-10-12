// A fake Supabase client for UI tests: in-memory auth with real event
// semantics (onAuthStateChange), and canned RPC results. Used with the REAL
// service layer, so screens are tested through the same code path as the app.
import type { Session } from '@supabase/supabase-js';
import type { AppSupabaseClient } from '@/lib/supabase';

type Listener = (event: string, session: Session | null) => void;

export const TEST_PASSWORD = 'Correct-horse-1';

export function makeSession(email = 'ada@example.test'): Session {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      email,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  } as Session;
}

export interface FakeOptions {
  session?: Session | null;
  /** Rows returned by rpc('my_communities'). */
  communities?: unknown[];
  /** Make getSession() hang (to observe the restoring state). */
  neverRestore?: boolean;
  /** The first RPC fails with an internal error. */
  failFirstRpc?: boolean;
}

export function fakeSupabase(options: FakeOptions = {}) {
  let session: Session | null = options.session ?? null;
  const listeners = new Set<Listener>();
  const emit = (event: string) => listeners.forEach((listener) => listener(event, session));

  const auth = {
    getSession: jest.fn(() =>
      options.neverRestore ? new Promise(() => {}) : Promise.resolve({ data: { session }, error: null }),
    ),
    onAuthStateChange: jest.fn((listener: Listener) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
    startAutoRefresh: jest.fn(async () => {}),
    stopAutoRefresh: jest.fn(async () => {}),
    signInWithPassword: jest.fn(async ({ email, password }: { email: string; password: string }) => {
      if (password !== TEST_PASSWORD) {
        return {
          data: { session: null, user: null },
          error: {
            name: 'AuthApiError',
            status: 400,
            code: 'invalid_credentials',
            message: 'Invalid login credentials',
          },
        };
      }
      session = makeSession(email);
      emit('SIGNED_IN');
      return { data: { session, user: session.user }, error: null };
    }),
    signOut: jest.fn(async () => {
      session = null;
      emit('SIGNED_OUT');
      return { error: null };
    }),
  };

  let failNext = options.failFirstRpc ?? false;
  const rpc = jest.fn(async (name: string) => {
    if (failNext) {
      failNext = false;
      return { data: null, error: { code: 'XX000', message: 'connection reset at /var/lib/postgresql' } };
    }
    if (name === 'my_communities') return { data: options.communities ?? [], error: null };
    return { data: null, error: { code: 'XX000', message: `unexpected rpc ${name}` } };
  });

  return { client: { auth, rpc } as unknown as AppSupabaseClient, auth, rpc, emit };
}

export const sampleCommunities = [
  {
    community_id: 'cccccccc-0000-4000-8000-000000000001',
    name: 'Maple Grove HOA',
    slug: 'maple-grove',
    community_type: 'residential',
    logo_url: null,
    community_status: 'active',
    membership_id: 'dddddddd-0000-4000-8000-000000000001',
    membership_status: 'active',
    joined_at: '2026-01-01T00:00:00Z',
    role_names: ['Owner'],
  },
  {
    community_id: 'cccccccc-0000-4000-8000-000000000002',
    name: 'St. Mark Choir',
    slug: 'st-mark-choir',
    community_type: 'church',
    logo_url: null,
    community_status: 'active',
    membership_id: 'dddddddd-0000-4000-8000-000000000002',
    membership_status: 'active',
    joined_at: '2026-01-01T00:00:00Z',
    role_names: ['Member'],
  },
];

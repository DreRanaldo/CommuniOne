// A fake Supabase client for UI tests: in-memory auth with real event
// semantics (onAuthStateChange), scripted email links, canned RPC results,
// and the user's own profile, phone and avatar files with the backend's
// visibility rules (profile_private and avatars are the owner's only). Used with the REAL service layer, so screens are tested through
// the same code path as the app.
import type { Session } from '@supabase/supabase-js';
import type { LinkSource } from '@/lib/links';
import type { MediaPicker, PickedImage } from '@/lib/media';
import type { AppSupabaseClient } from '@/lib/supabase';

type Listener = (event: string, session: Session | null) => void;

export const TEST_PASSWORD = 'Correct-horse-1';
export const TEST_EMAIL = 'ada@example.test';
export const TEST_USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** Another member of the user's community; their phone number must never reach this user. */
export const OTHER_USER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
export const OTHER_PHONE = '+1 555 0100';

export function makeSession(email = TEST_EMAIL): Session {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: TEST_USER_ID,
      email,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
      email_confirmed_at: '2026-01-01T00:05:00Z',
      last_sign_in_at: '2026-10-01T09:00:00Z',
    },
  } as Session;
}

export interface FakeOptions {
  session?: Session | null;
  /** Rows returned by rpc('my_communities') (the caller's memberships; change with setCommunities). */
  communities?: unknown[];
  /** Make getSession() hang (to observe the restoring state). */
  neverRestore?: boolean;
  /** The first RPC fails with an internal error. */
  failFirstRpc?: boolean;
  /** The stored session was revoked on the server (Auth answers 403 session_not_found). */
  revoked?: boolean;
  /** Every network request fails (airplane mode). */
  offline?: boolean;
  /** Overrides for the signed-in user's profile row. */
  profile?: Partial<ProfileRow>;
  /** The signed-in user's private phone number. */
  phone?: string | null;
  /** delete_my_account refuses: the user is the only Owner of a community with members. */
  deleteConflict?: boolean;
}

export interface ProfileRow {
  id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  avatar_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

type DbError = { code: string; message: string; status?: number };
type Filter = [column: string, value: unknown];

const profileRow = (id: string, values: Partial<ProfileRow> = {}): ProfileRow => ({
  id,
  display_name: null,
  first_name: null,
  last_name: null,
  bio: null,
  avatar_url: null,
  avatar_path: null,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...values,
});

const pick = (row: object, columns: string) =>
  columns === '*'
    ? { ...row }
    : Object.fromEntries(
        columns.split(',').map((c) => [c.trim(), (row as Record<string, unknown>)[c.trim()]]),
      );

const NETWORK_ERROR = { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' };

export function fakeSupabase(options: FakeOptions = {}) {
  let session: Session | null = options.session ?? null;
  let revoked = options.revoked ?? false;
  let offline = options.offline ?? false;
  const listeners = new Set<Listener>();
  const emit = (event: string) => listeners.forEach((listener) => listener(event, session));
  const clear = (event = 'SIGNED_OUT') => {
    session = null;
    emit(event);
  };

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
    // Like supabase-js: a revoked session is cleared (SIGNED_OUT) when Auth says it is gone.
    getUser: jest.fn(async () => {
      if (offline) return { data: { user: null }, error: NETWORK_ERROR };
      if (!session)
        return {
          data: { user: null },
          error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' },
        };
      if (revoked) {
        clear();
        return {
          data: { user: null },
          error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' },
        };
      }
      return { data: { user: session.user }, error: null };
    }),
    signInWithPassword: jest.fn(async ({ email, password }: { email: string; password: string }) => {
      if (offline) return { data: { session: null, user: null }, error: NETWORK_ERROR };
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
      revoked = false;
      emit('SIGNED_IN');
      return { data: { session, user: session.user }, error: null };
    }),
    signUp: jest.fn(async (_input: { email: string; password: string; options?: unknown }) => {
      if (offline) return { data: { session: null, user: null }, error: NETWORK_ERROR };
      return { data: { session: null, user: { id: 'new-user' } }, error: null };
    }),
    resetPasswordForEmail: jest.fn(async (_email: string, _options?: unknown) => {
      if (offline) return { data: null, error: NETWORK_ERROR };
      return { data: {}, error: null };
    }),
    exchangeCodeForSession: jest.fn(async (code: string) => {
      if (code === 'expired-code') {
        return {
          data: { session: null },
          error: { name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'expired' },
        };
      }
      session = makeSession();
      emit('SIGNED_IN');
      return { data: { session }, error: null };
    }),
    updateUser: jest.fn(async (_attributes: { password?: string }) => ({
      data: { user: session?.user ?? null },
      error: null,
    })),
    signOut: jest.fn(async (_options?: { scope?: string }) => {
      clear();
      return { error: null };
    }),
  };

  // ---- Data API: profiles (own row and co-members), profile_private (own row only) ----
  const profiles = new Map<string, ProfileRow>([
    [
      TEST_USER_ID,
      profileRow(TEST_USER_ID, {
        display_name: 'Ada L.',
        first_name: 'Ada',
        last_name: 'Lovelace',
        bio: 'Analytical engines.',
        ...options.profile,
      }),
    ],
    [OTHER_USER_ID, profileRow(OTHER_USER_ID, { display_name: 'Grace H.' })],
  ]);
  const phones = new Map<string, string | null>([
    [TEST_USER_ID, options.phone === undefined ? '+44 20 7946 0000' : options.phone],
    [OTHER_USER_ID, OTHER_PHONE],
  ]);
  const files = new Set<string>();
  const queries: { table: string; op: string; filters: Filter[]; values?: unknown }[] = [];
  const dbErrors: DbError[] = [];
  const me = () => (session && !revoked ? session.user.id : null);
  const AUTH_REQUIRED: DbError = { code: '42501', message: 'authentication required' };
  const OFFLINE: DbError = { code: '', message: 'TypeError: Network request failed', status: 0 };

  const runQuery = async (
    table: string,
    op: string,
    filters: Filter[],
    columns: string,
    values: Record<string, unknown> | undefined,
    single: boolean,
  ): Promise<{ data: unknown; error: DbError | null }> => {
    queries.push({ table, op, filters, values });
    if (offline) return { data: null, error: OFFLINE };
    const injected = dbErrors.shift();
    if (injected) return { data: null, error: injected };
    const user = me();
    if (!user) return { data: single ? null : [], error: null };
    const matches = (row: Record<string, unknown>) => filters.every(([c, v]) => row[c] === v);
    if (table === 'profiles') {
      // RLS: the user's own profile and co-members' profiles are readable; only their own is writable.
      const visible = [...profiles.values()].filter((row) => matches({ ...row }));
      if (op === 'select') {
        const rows = visible.map((row) => pick(row, columns));
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        const own = visible.filter((row) => row.id === user);
        const path = values?.avatar_path;
        if (typeof path === 'string' && (!path.startsWith(`${user}/`) || !files.has(path))) {
          return {
            data: null,
            error: { code: '42501', message: 'an avatar must be an image uploaded to your own folder' },
          };
        }
        own.forEach((row) => Object.assign(row, values, { updated_at: new Date().toISOString() }));
        return { data: own.map((row) => pick(row, columns)), error: null };
      }
    }
    if (table === 'profile_private') {
      // RLS: owner only. Other people's rows simply do not exist for this user.
      if (op === 'select') {
        const rows =
          filters.every(([c, v]) => c === 'user_id' && v === user) && phones.has(user)
            ? [{ user_id: user, phone: phones.get(user) ?? null }]
            : [];
        const shaped = rows.map((row) => pick(row, columns));
        return { data: single ? (shaped[0] ?? null) : shaped, error: null };
      }
      if (op === 'upsert') {
        phones.set(user, (values?.phone as string | null) ?? null);
        return { data: null, error: null };
      }
    }
    return { data: null, error: { code: '42501', message: `permission denied for ${table}` } };
  };

  const from = jest.fn((table: string) => {
    let op = 'select';
    let columns = '*';
    let values: Record<string, unknown> | undefined;
    let single = false;
    const filters: Filter[] = [];
    const builder = {
      select(cols = '*') {
        columns = cols;
        return builder;
      },
      update(row: Record<string, unknown>) {
        op = 'update';
        values = row;
        return builder;
      },
      upsert(row: Record<string, unknown>) {
        op = 'upsert';
        values = row;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      then<T>(resolve: (value: { data: unknown; error: DbError | null }) => T, reject?: (e: unknown) => T) {
        return runQuery(table, op, filters, columns, values, single).then(resolve, reject);
      },
    };
    return builder;
  });

  // ---- Storage: the private avatars bucket (own folder only) ----
  const storageBucket = {
    upload: jest.fn(async (path: string, _body: unknown, _options?: unknown) => {
      if (offline) return { data: null, error: { message: 'Network request failed' } };
      const user = me();
      if (!user || !path.startsWith(`${user}/`)) {
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      }
      files.add(path);
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      paths.forEach((path) => files.delete(path));
      return { data: [], error: null };
    }),
    createSignedUrl: jest.fn(async (path: string, seconds: number) =>
      files.has(path) && me()
        ? { data: { signedUrl: `https://storage.test/avatars/${path}?expires=${seconds}` }, error: null }
        : { data: null, error: { message: 'Object not found' } },
    ),
  };
  const storage = { from: jest.fn((_bucket: string) => storageBucket) };
  if (options.profile?.avatar_path) files.add(options.profile.avatar_path);

  let communities = options.communities ?? [];
  let failNext = options.failFirstRpc ?? false;
  const rpc = jest.fn(async (name: string) => {
    if (failNext) {
      failNext = false;
      return { data: null, error: { code: 'XX000', message: 'connection reset at /var/lib/postgresql' } };
    }
    // The database refuses a revoked session (migration 8): 42501 "authentication required".
    if (revoked) return { data: null, error: { code: '42501', message: 'authentication required' } };
    if (name === 'my_communities') {
      if (offline) return { data: null, error: OFFLINE };
      return { data: communities, error: null };
    }
    if (name === 'delete_my_account') {
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      if (options.deleteConflict) {
        return {
          data: null,
          error: {
            code: '55000',
            message:
              'transfer the ability to manage roles to another member first; required in: Maple Grove HOA',
          },
        };
      }
      // The database deletes everything personal (CASCADE) and revokes the sessions.
      profiles.delete(user);
      phones.delete(user);
      revoked = true;
      return { data: null, error: null };
    }
    return { data: null, error: { code: 'XX000', message: `unexpected rpc ${name}` } };
  });

  return {
    client: { auth, rpc, from, storage } as unknown as AppSupabaseClient,
    auth,
    rpc,
    from,
    storage: storageBucket,
    profiles,
    phones,
    files,
    /** Every Data API query, in order (table, operation, filters, values). */
    queries,
    /** Change the user's memberships on the server (e.g. removed from a community). */
    setCommunities: (rows: unknown[]) => {
      communities = rows;
    },
    /** The next RPC fails with an internal error. */
    failNextRpc: () => {
      failNext = true;
    },
    /** The next Data API query fails with this error. */
    failNextQuery: (error: DbError = { code: 'XX000', message: 'internal error at /var/lib/postgresql' }) => {
      dbErrors.push(error);
    },
    emit,
    /** Supabase gave up on the session by itself (e.g. the refresh token was revoked). */
    expireSession: () => clear(),
    /** Revoke the session on the server (another device signed out everywhere). */
    revokeSession: () => {
      revoked = true;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
}

/** A scripted photo library: returns the next queued image (null = the user cancelled). */
export function fakeMedia() {
  const queue: (PickedImage | null | Error)[] = [];
  const picker: MediaPicker = {
    pickAvatar: jest.fn(async () => {
      const next = queue.length ? queue.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
  };
  return {
    picker,
    next(image: PickedImage | null | Error) {
      queue.push(image);
    },
  };
}

export const pickedImage = (size = 2048): PickedImage => ({
  bytes: new Uint8Array(size).fill(0xff),
  mimeType: 'image/jpeg',
  uri: 'file:///cache/avatar.jpg',
});

/** A controllable deep-link source. */
export function fakeLinks(initialURL: string | null = null) {
  const listeners = new Set<(url: string) => void>();
  const source: LinkSource = {
    getInitialURL: async () => initialURL,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { source, open: (url: string) => listeners.forEach((listener) => listener(url)) };
}

/** A my_communities() row: an active membership in an active community unless overridden. */
export function makeCommunity(n: number, overrides: Record<string, unknown> = {}) {
  const id = String(n).padStart(12, '0');
  return {
    community_id: `cccccccc-0000-4000-8000-${id}`,
    name: `Community ${n}`,
    slug: `community-${n}`,
    community_type: 'other',
    logo_url: null,
    community_status: 'active',
    membership_id: `dddddddd-0000-4000-8000-${id}`,
    membership_status: 'active',
    joined_at: '2026-01-01T00:00:00Z',
    role_names: ['Member'],
    ...overrides,
  };
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

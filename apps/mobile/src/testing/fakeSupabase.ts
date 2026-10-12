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
  /** Invitations by token (preview_invitation / redeem_invitation). */
  invitations?: Record<string, FakeInvitation>;
  /** create_community refuses: the daily creation limit was reached. */
  creationLimitReached?: boolean;
  /** The first N create_community calls find their address (slug) already taken. */
  slugsTaken?: number;
  /** Community content by community id (alerts, announcements, upcoming events, posts). */
  content?: Record<string, FakeContent>;
  /** Permission keys by community id; otherwise derived from the user's roles there. */
  permissions?: Record<string, string[]>;
}

export interface FakeContent {
  alerts?: Record<string, unknown>[];
  announcements?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  posts?: Record<string, unknown>[];
}

/**
 * A server-side invitation. `state` mirrors the database checks: revoked,
 * expired (time or used up) and stale (its creator lost members.invite).
 */
export interface FakeInvitation {
  /** The community, as a my_communities() row (see makeCommunity) plus optional details. */
  community: {
    community_id: string;
    membership_id: string;
    name: string;
    community_type: string;
    logo_url: string | null;
    logo_path?: string | null;
    description?: string | null;
    cover_image_path?: string | null;
    [key: string]: unknown;
  };
  state?: 'valid' | 'revoked' | 'expired' | 'stale';
  memberCount?: number;
}

/** An invitation token as the database issues them (ci_ + 64 hex). Built at runtime: tests hold no secret-like literals. */
export const invitationToken = (n: number) => `ci_${n.toString(16).padStart(64, '0')}`;

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

/** Default role permissions for posts (seed role templates). */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  Owner: ['posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own', 'posts.moderate'],
  Admin: ['posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own', 'posts.moderate'],
  Moderator: ['posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own', 'posts.moderate'],
  Member: ['posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own'],
};

type PostRow = ReturnType<typeof makePost>;
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

  // ---- communities table (rows for the user's memberships and created communities) ----
  type CommunityRow = Record<string, unknown> & { id: string; slug: string };
  const communityRows = new Map<string, CommunityRow>();
  const addCommunityRow = (c: Record<string, unknown>) =>
    communityRows.set(c.community_id as string, {
      id: c.community_id as string,
      name: c.name,
      slug: c.slug as string,
      community_type: c.community_type,
      description: (c.description as string | null | undefined) ?? null,
      timezone: 'UTC',
      status: c.community_status,
      logo_url: c.logo_url ?? null,
      logo_path: c.logo_path ?? null,
      cover_image_url: null,
      cover_image_path: c.cover_image_path ?? null,
    });

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
    if (table === 'posts') {
      const all = Object.values(content).flatMap((c) => c.posts ?? []) as PostRow[];
      const byId = (id: unknown) => all.find((row) => row.id === id);
      if (op === 'insert') {
        const communityId = String(values?.community_id);
        // RLS: posts.create in that community; authorship always comes from the session.
        if (!permissionsIn(communityId).includes('posts.create')) {
          return {
            data: null,
            error: { code: '42501', message: 'new row violates row-level security policy for table "posts"' },
          };
        }
        const latest = Math.max(Date.now(), ...all.map((row) => Date.parse(row.created_at) + 1000));
        const row: PostRow = {
          ...makePost(communityId, 0),
          id: `d4d4d4d4-0000-4000-8000-${String(++postCount).padStart(12, '0')}`,
          author_user_id: user,
          author_display_name: profiles.get(user)?.display_name ?? null,
          body: String(values?.body),
          reaction_count: 0,
          created_at: new Date(latest).toISOString(),
          updated_at: new Date(latest).toISOString(),
        };
        content[communityId] = {
          ...content[communityId],
          posts: [row, ...(content[communityId]?.posts ?? [])],
        };
        return { data: pick(row, columns), error: null };
      }
      const target = byId(filters.find(([c]) => c === 'id')?.[1]);
      const visible = target && canViewPost(target) ? target : undefined;
      if (op === 'select') {
        const rows = visible ? [pick(visible, columns)] : [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        if (!visible) return { data: [], error: null };
        const perms = permissionsIn(visible.community_id);
        const own = visible.author_user_id === user;
        const allowed =
          values?.status === 'deleted'
            ? (own && perms.includes('posts.delete_own')) || perms.includes('posts.moderate')
            : 'body' in (values ?? {})
              ? own && perms.includes('posts.edit_own') && visible.status === 'published'
              : perms.includes('posts.moderate');
        if (!allowed) return { data: [], error: null };
        Object.assign(
          visible,
          values,
          'body' in (values ?? {}) ? { edited_at: new Date().toISOString() } : {},
        );
        return { data: [pick(visible, columns)], error: null };
      }
    }
    if (table === 'reactions') {
      const postId = filters.find(([c]) => c === 'post_id')?.[1] ?? values?.post_id;
      const post = (Object.values(content).flatMap((c) => c.posts ?? []) as PostRow[]).find(
        (row) => row.id === postId,
      );
      const mine = reactions.find((r) => r.postId === postId && r.userId === user);
      if (op === 'select')
        return {
          data: single ? (mine ? { id: mine.id } : null) : mine ? [{ id: mine.id }] : [],
          error: null,
        };
      if (!post || !canViewPost(post)) {
        return {
          data: null,
          error: {
            code: '42501',
            message: 'new row violates row-level security policy for table "reactions"',
          },
        };
      }
      if (op === 'insert') {
        reactions.push({
          id: `e5e5e5e5-0000-4000-8000-${String(reactions.length + 1).padStart(12, '0')}`,
          postId: post.id,
          userId: user,
        });
        post.reaction_count = Number(post.reaction_count) + 1;
        post.my_reaction_type = String(values?.reaction_type);
        return { data: null, error: null };
      }
      if (op === 'update') {
        post.my_reaction_type = String(values?.reaction_type);
        return { data: null, error: null };
      }
      if (op === 'delete' && mine) {
        reactions.splice(reactions.indexOf(mine), 1);
        post.reaction_count = Number(post.reaction_count) - 1;
        post.my_reaction_type = null;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'communities') {
      // RLS: active members read; community.update holders (Owner, Admin) write.
      const membership = (id: string) =>
        communities.find((c) => (c as { community_id: string }).community_id === id) as
          { membership_status: string } | undefined;
      const visible = [...communityRows.values()].filter(
        (row) => membership(row.id)?.membership_status === 'active' && matches({ ...row }),
      );
      if (op === 'select') {
        const rows = visible.map((row) => pick(row, columns));
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        const writable = visible.filter((row) => manages(row.id));
        for (const key of ['logo_path', 'cover_image_path'] as const) {
          const path = values?.[key];
          if (
            typeof path === 'string' &&
            writable.some((row) => !path.startsWith(`${row.id}/`) || !mediaFiles.has(path))
          ) {
            return {
              data: null,
              error: {
                code: '42501',
                message: "community images must be uploaded to that community's folder",
              },
            };
          }
        }
        writable.forEach((row) => Object.assign(row, values));
        return { data: writable.map((row) => pick(row, columns)), error: null };
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
      insert(row: Record<string, unknown>) {
        op = 'insert';
        values = row;
        return builder;
      },
      delete() {
        op = 'delete';
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
  // ---- Storage: the public community-media bucket (community managers only) ----
  const mediaFiles = new Set<string>();
  const manages = (communityId: string) =>
    communities.some(
      (c) =>
        (c as { community_id: string }).community_id === communityId &&
        (c as { membership_status: string }).membership_status === 'active' &&
        (c as { role_names: string[] }).role_names.some((r) => r === 'Owner' || r === 'Admin'),
    );
  const mediaBucket = {
    upload: jest.fn(async (path: string, _body: unknown, _options?: unknown) => {
      if (offline) return { data: null, error: { message: 'Network request failed' } };
      const user = me();
      if (!user || !manages(path.split('/')[0] ?? '')) {
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      }
      mediaFiles.add(path);
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      paths.forEach((path) => mediaFiles.delete(path));
      return { data: [], error: null };
    }),
    getPublicUrl: jest.fn((path: string) => ({
      data: { publicUrl: `https://storage.test/public/community-media/${path}` },
    })),
  };
  const storage = {
    from: jest.fn((bucket: string) => (bucket === 'community-media' ? mediaBucket : storageBucket)),
  };
  if (options.profile?.avatar_path) files.add(options.profile.avatar_path);

  let communities = options.communities ?? [];
  communities.forEach((c) => addCommunityRow(c as Record<string, unknown>));
  const invitations = new Map(Object.entries(options.invitations ?? {}));
  const redemptions: { token: string; userId: string }[] = [];
  const content: Record<string, FakeContent> = { ...options.content };
  const rpcFailures = new Map<string, DbError>();
  const reactions: { id: string; postId: string; userId: string }[] = [];
  let postCount = 100;
  /** The user's permission keys in a community (active membership only), like my_community_permissions(). */
  const permissionsIn = (communityId: string): string[] => {
    const membership = communities.find(
      (c) =>
        (c as { community_id: string }).community_id === communityId &&
        (c as { membership_status: string }).membership_status === 'active',
    ) as { role_names: string[] } | undefined;
    if (!membership || !me()) return [];
    if (options.permissions?.[communityId]) return options.permissions[communityId]!;
    return [...new Set(membership.role_names.flatMap((role) => ROLE_PERMISSIONS[role] ?? []))];
  };
  /** private.can_view_post_row(): published → posts.view; hidden/deleted → moderators, or the author. */
  const canViewPost = (row: PostRow) => {
    const perms = permissionsIn(row.community_id);
    if (row.status === 'published') return perms.includes('posts.view');
    return perms.includes('posts.moderate') || (row.author_user_id === me() && perms.includes('posts.view'));
  };
  let createdCount = 0;
  let slugsTaken = options.slugsTaken ?? 0;
  let failNext = options.failFirstRpc ?? false;
  const rpc = jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
    if (failNext) {
      failNext = false;
      return { data: null, error: { code: 'XX000', message: 'connection reset at /var/lib/postgresql' } };
    }
    // The database refuses a revoked session (migration 8): 42501 "authentication required".
    if (revoked) return { data: null, error: { code: '42501', message: 'authentication required' } };
    if (name === 'my_communities') {
      if (offline) return { data: null, error: OFFLINE };
      // Like the database function: community fields come from the communities table.
      const rows = communities.map((c) => {
        const row = communityRows.get((c as { community_id: string }).community_id);
        return row ? { ...(c as object), logo_path: row.logo_path ?? null } : c;
      });
      return { data: rows, error: null };
    }
    const failure = rpcFailures.get(name);
    if (failure) {
      rpcFailures.delete(name);
      return { data: null, error: failure };
    }
    const CONTENT_RPCS: Record<string, keyof FakeContent> = {
      list_active_alerts: 'alerts',
      list_current_announcements: 'announcements',
      list_upcoming_events: 'events',
    };
    if (name === 'my_community_permissions') {
      return { data: permissionsIn(String(args.p_community_id)), error: null };
    }
    if (name === 'list_community_posts') {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      // SECURITY INVOKER + RLS: each row must be visible to the caller.
      const status = String(args.p_status ?? 'published');
      const cursor = args.p_cursor_created_at
        ? [String(args.p_cursor_created_at), String(args.p_cursor_id)]
        : null;
      const rows = ((content[String(args.p_community_id)]?.posts ?? []) as PostRow[])
        .filter((row) => row.status === status && canViewPost(row))
        .sort((a, b) =>
          a.created_at === b.created_at ? b.id.localeCompare(a.id) : b.created_at.localeCompare(a.created_at),
        )
        .filter(
          (row) =>
            !cursor || row.created_at < cursor[0]! || (row.created_at === cursor[0] && row.id < cursor[1]!),
        )
        .slice(0, Number(args.p_limit ?? 20));
      return { data: rows.map((row) => ({ ...row })), error: null };
    }
    if (name in CONTENT_RPCS) {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      // Like the database: only active members of that community see its content (otherwise nothing).
      const id = String(args.p_community_id);
      const member = communities.some(
        (c) =>
          (c as { community_id: string }).community_id === id &&
          (c as { membership_status: string }).membership_status === 'active',
      );
      const rows = member ? (content[id]?.[CONTENT_RPCS[name]!] ?? []) : [];
      return { data: rows.slice(0, Number(args.p_limit ?? 20)), error: null };
    }
    if (name === 'create_community') {
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      if (options.creationLimitReached) {
        return {
          data: null,
          error: { code: '53400', message: 'community creation limit reached (10 per 24 hours)' },
        };
      }
      if (slugsTaken > 0 || [...communityRows.values()].some((row) => row.slug === args.p_slug)) {
        slugsTaken -= 1;
        return {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "communities_slug_key"',
          },
        };
      }
      if (String(args.p_timezone).startsWith('Mars/')) {
        return {
          data: null,
          error: { code: '22023', message: `invalid timezone: ${String(args.p_timezone)}` },
        };
      }
      // The database makes the caller Owner with an active membership (create_community()).
      createdCount += 1;
      const membership = makeCommunity(900 + createdCount, {
        name: args.p_name,
        slug: args.p_slug,
        community_type: args.p_community_type,
        role_names: ['Owner'],
        description: args.p_description ?? null,
      });
      communities = [...communities, membership];
      addCommunityRow(membership);
      const row = communityRows.get(membership.community_id)!;
      row.timezone = args.p_timezone;
      return { data: { ...row }, error: null };
    }
    if (name === 'preview_invitation' || name === 'redeem_invitation') {
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      // Same checks, order and errors as the database functions.
      const invitation = invitations.get(String(args.p_token));
      if (!invitation) return { data: null, error: { code: 'P0002', message: 'invalid invitation' } };
      const state = invitation.state ?? 'valid';
      const refusal = {
        revoked: 'this invitation has been revoked',
        expired: 'this invitation has expired',
        stale: 'this invitation is no longer valid',
        valid: null,
      }[state];
      if (refusal) return { data: null, error: { code: '22023', message: refusal } };
      const target = invitation.community;
      const existing = communities.find(
        (c) => (c as { community_id: string }).community_id === target.community_id,
      ) as { membership_status: string } | undefined;
      if (name === 'preview_invitation') {
        return {
          data: [
            {
              community_id: target.community_id,
              name: target.name,
              community_type: target.community_type,
              description: target.description ?? null,
              logo_url: target.logo_url,
              logo_path: (target as { logo_path?: string | null }).logo_path ?? null,
              cover_image_url: null,
              cover_image_path: target.cover_image_path ?? null,
              member_count: invitation.memberCount ?? 12,
              expires_at: '2026-12-01T00:00:00Z',
              membership_status: existing?.membership_status ?? null,
            },
          ],
          error: null,
        };
      }
      if (existing?.membership_status === 'active') {
        return {
          data: null,
          error: { code: '23505', message: 'you are already a member of this community' },
        };
      }
      if (existing?.membership_status === 'suspended') {
        return {
          data: null,
          error: { code: '42501', message: 'your membership in this community is suspended' },
        };
      }
      // Joins (or re-admits) as an active Member with the default role.
      const joined = { ...target, membership_status: 'active', role_names: ['Member'] };
      communities = [
        ...communities.filter((c) => (c as { community_id: string }).community_id !== target.community_id),
        joined,
      ];
      addCommunityRow(joined);
      redemptions.push({ token: String(args.p_token), userId: user });
      return {
        data: [
          {
            community_id: target.community_id,
            membership_id: joined.membership_id,
            membership_status: 'active',
          },
        ],
        error: null,
      };
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
    /** The public community-media bucket. */
    mediaStorage: mediaBucket,
    mediaFiles,
    communityRows,
    /** Successful invitation redemptions, in order. */
    redemptions,
    /** Server-side invitations by token (change one to simulate a revocation). */
    invitations,
    /** Community content by community id (change it to simulate new posts, alerts, ...). */
    content,
    /** The user's memberships as my_communities() currently returns them. */
    memberships: () => communities,
    /** Every Data API query, in order (table, operation, filters, values). */
    queries,
    /** Change the user's memberships on the server (e.g. removed from a community). */
    setCommunities: (rows: unknown[]) => {
      communities = rows;
    },
    /** The next call of one RPC fails (default: an internal error). */
    failRpcOnce: (
      rpcName: string,
      error: DbError = { code: 'XX000', message: 'internal error at /var/lib/postgresql' },
    ) => {
      rpcFailures.set(rpcName, error);
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
    pickImage: jest.fn(async (_kind: string) => {
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
export function makeCommunity<O extends Record<string, unknown> = Record<string, never>>(
  n: number,
  overrides: O = {} as O,
) {
  const id = String(n).padStart(12, '0');
  const base = {
    community_id: `cccccccc-0000-4000-8000-${id}`,
    name: `Community ${n}`,
    slug: `community-${n}`,
    community_type: 'other',
    logo_url: null as string | null,
    community_status: 'active',
    membership_id: `dddddddd-0000-4000-8000-${id}`,
    membership_status: 'active',
    joined_at: '2026-01-01T00:00:00Z',
    role_names: ['Member'],
  };
  return { ...base, ...overrides } as Omit<typeof base, keyof O> & O;
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

// ---- Community content rows, as the list functions return them ----
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 12, 0) + minutes * 60_000).toISOString();

export const makeAlert = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `a1a1a1a1-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  title: `Alert ${n}`,
  body: `Alert body ${n}`,
  severity: 'warning',
  severity_rank: 2,
  is_emergency: false,
  published_at: at(-n),
  published_by: null,
  expires_at: null,
  edited_at: null,
  ...overrides,
});

export const makeAnnouncement = (
  communityId: string,
  n: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `b2b2b2b2-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  title: `Announcement ${n}`,
  body: `Announcement body ${n}`,
  priority: 'normal',
  status: 'published',
  author_user_id: null,
  published_at: at(-60 * n),
  expires_at: null,
  edited_at: null,
  ...overrides,
});

export const makeEvent = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `c3c3c3c3-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  title: `Event ${n}`,
  description: null,
  location_text: `Hall ${n}`,
  starts_at: at(60 * 24 * n),
  ends_at: at(60 * 24 * n + 120),
  timezone: 'UTC',
  status: 'published',
  capacity: null,
  ...overrides,
});

export const makePost = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `d4d4d4d4-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  author_user_id: OTHER_USER_ID as string | null,
  author_display_name: 'Grace H.' as string | null,
  author_avatar_url: null as string | null,
  body: `Post body ${n}`,
  status: 'published',
  visibility: 'members',
  reaction_count: n,
  comment_count: 0,
  my_reaction_type: null as string | null,
  moderation_reason: null as string | null,
  created_at: at(-30 * n),
  updated_at: at(-30 * n),
  edited_at: null as string | null,
  ...overrides,
});

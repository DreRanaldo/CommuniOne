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
  comments?: Record<string, unknown>[];
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
const MEMBER_PERMISSIONS = [
  'alerts.view',
  'announcements.view',
  'posts.view',
  'posts.create',
  'posts.edit_own',
  'posts.delete_own',
  'comments.create',
  'comments.edit_own',
  'comments.delete_own',
];
const MODERATION = ['posts.moderate', 'comments.moderate'];
const MANAGEMENT = ['alerts.create', 'alerts.manage', 'announcements.create', 'announcements.manage'];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  Owner: [...MEMBER_PERMISSIONS, ...MODERATION, ...MANAGEMENT],
  Admin: [...MEMBER_PERMISSIONS, ...MODERATION, ...MANAGEMENT],
  Moderator: [...MEMBER_PERMISSIONS, ...MODERATION],
  Member: MEMBER_PERMISSIONS,
};

type PostRow = ReturnType<typeof makePost>;
type CommentRow = ReturnType<typeof makeComment>;
type AnnouncementRow = ReturnType<typeof makeAnnouncement>;
type AlertRow = ReturnType<typeof makeAlert>;
const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, urgent: 3, emergency: 4 };
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
    if (table === 'alerts') {
      const all = () => Object.values(content).flatMap((c) => c.alerts ?? []) as AlertRow[];
      const now = new Date().toISOString();
      const futureExpiry = (expires: unknown) => !expires || Date.parse(String(expires)) > Date.now();
      const invalid = (message: string) => ({ data: null, error: { code: '22023', message } });
      const denied = (message: string) => ({ data: null, error: { code: '42501', message } });
      if (op === 'insert') {
        // alerts_insert_authorized + enforce_alert_write().
        const communityId = String(values?.community_id);
        const perms = permissionsIn(communityId);
        const severity = String(values?.severity ?? 'info');
        const status = String(values?.status ?? 'draft');
        if (
          !perms.includes('alerts.create') ||
          (severity === 'emergency' && !perms.includes('alerts.manage'))
        ) {
          return denied('new row violates row-level security policy for table "alerts"');
        }
        if (status === 'published' && !futureExpiry(values?.expires_at))
          return invalid('expires_at must be in the future when publishing');
        const row: AlertRow = {
          ...makeAlert(communityId, ++alertCount),
          title: String(values?.title),
          body: String(values?.body),
          severity,
          severity_rank: SEVERITY_RANK[severity]!,
          is_emergency: severity === 'emergency',
          expires_at: (values?.expires_at as string | null) ?? null,
          status,
          created_by: user,
          published_at: status === 'published' ? now : null,
          published_by: status === 'published' ? user : null,
          created_at: now,
          updated_at: now,
        };
        content[communityId] = {
          ...content[communityId],
          alerts: [row, ...(content[communityId]?.alerts ?? [])],
        };
        return { data: pick(row, columns), error: null };
      }
      const target = all().find((row) => row.id === filters.find(([c]) => c === 'id')?.[1]);
      const visible = target && canViewAlert(target) ? target : undefined;
      if (op === 'select') {
        const rows = visible ? [pick(visible, columns)] : [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        if (!visible || !canManageAlert(visible)) return { data: [], error: null };
        // enforce_alert_write(): transitions, stamps, severity and edit rules.
        const manager = permissionsIn(visible.community_id).includes('alerts.manage');
        if (visible.status === 'archived') return denied('archived alerts cannot be modified');
        const next = { ...visible, ...values } as AlertRow;
        if (next.severity !== visible.severity) {
          if (
            !manager &&
            (visible.status !== 'draft' || next.severity === 'emergency' || visible.severity === 'emergency')
          )
            return denied("changing this alert's severity requires alerts.manage");
          next.severity_rank = SEVERITY_RANK[next.severity]!;
          next.is_emergency = next.severity === 'emergency';
        }
        if (next.status !== visible.status) {
          const allowed: Record<string, string[]> = {
            draft: ['published', 'cancelled'],
            published: ['cancelled', 'expired'],
            cancelled: ['archived'],
            expired: ['archived'],
          };
          if (!allowed[visible.status]?.includes(next.status))
            return invalid(`invalid alert transition: ${visible.status} -> ${next.status}`);
          if (next.status === 'published') {
            if (next.severity === 'emergency' && !manager)
              return denied('publishing an emergency alert requires alerts.manage');
            if (!futureExpiry(next.expires_at))
              return invalid('expires_at must be in the future when publishing');
            next.published_at = now;
            next.published_by = user;
          }
          if (next.status === 'cancelled') next.cancelled_at = now;
          if (next.status === 'expired') next.expired_at = now;
          if (next.status === 'archived') next.archived_at = now;
        }
        if (
          next.cancellation_reason !== visible.cancellation_reason &&
          !(next.status === 'cancelled' && visible.status !== 'cancelled')
        )
          return invalid('a cancellation reason can only be given when cancelling');
        const edited = ['title', 'body', 'severity', 'expires_at'].some(
          (k) =>
            k in (values ?? {}) &&
            (values as Record<string, unknown>)[k] !== (visible as Record<string, unknown>)[k],
        );
        if (edited) {
          if (
            !['draft', 'published'].includes(visible.status) ||
            !['draft', 'published'].includes(next.status)
          )
            return denied('only draft or published alerts can be edited');
          if (
            next.status === 'published' &&
            next.expires_at !== visible.expires_at &&
            !futureExpiry(next.expires_at)
          )
            return invalid('expires_at must be in the future; use status = expired to end an alert now');
          if (visible.status === 'published') next.edited_at = now;
        }
        next.updated_at = now;
        Object.assign(visible, next);
        return { data: [pick(visible, columns)], error: null };
      }
    }
    if (table === 'announcements') {
      const all = () => Object.values(content).flatMap((c) => c.announcements ?? []) as AnnouncementRow[];
      const now = new Date().toISOString();
      const futureExpiry = (expires: unknown) => !expires || Date.parse(String(expires)) > Date.now();
      const invalid = (message: string) => ({ data: null, error: { code: '22023', message } });
      if (op === 'insert') {
        const communityId = String(values?.community_id);
        const perms = permissionsIn(communityId);
        if (!perms.includes('announcements.create') && !perms.includes('announcements.manage')) {
          return {
            data: null,
            error: {
              code: '42501',
              message: 'new row violates row-level security policy for table "announcements"',
            },
          };
        }
        const status = String(values?.status ?? 'draft');
        if (status === 'published' && !futureExpiry(values?.expires_at))
          return invalid('expires_at must be in the future when publishing');
        const row: AnnouncementRow = {
          ...makeAnnouncement(communityId, ++announcementCount),
          title: String(values?.title),
          body: String(values?.body),
          priority: String(values?.priority ?? 'normal'),
          expires_at: (values?.expires_at as string | null) ?? null,
          status,
          author_user_id: user,
          published_at: status === 'published' ? now : null,
          created_at: now,
        };
        content[communityId] = {
          ...content[communityId],
          announcements: [row, ...(content[communityId]?.announcements ?? [])],
        };
        return { data: pick(row, columns), error: null };
      }
      const target = all().find((row) => row.id === filters.find(([c]) => c === 'id')?.[1]);
      const visible = target && canViewAnnouncement(target) ? target : undefined;
      if (op === 'select') {
        const rows = visible ? [pick(visible, columns)] : [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        if (!visible || !canManageAnnouncement(visible)) return { data: [], error: null };
        // enforce_announcement_write(): transitions, publication stamps, edit rules.
        if (visible.status === 'deleted')
          return {
            data: null,
            error: { code: '42501', message: 'deleted announcements cannot be modified' },
          };
        const next = { ...visible, ...values } as AnnouncementRow;
        if (next.status !== visible.status) {
          const allowed: Record<string, string[]> = {
            draft: ['published', 'deleted'],
            published: ['archived', 'deleted'],
            archived: ['published', 'deleted'],
          };
          if (!allowed[visible.status]?.includes(next.status))
            return invalid(`invalid announcement transition: ${visible.status} -> ${next.status}`);
          if (next.status === 'published') {
            if (!futureExpiry(next.expires_at))
              return invalid('expires_at must be in the future when publishing');
            next.published_at = now;
            next.archived_at = null;
          }
          if (next.status === 'archived') next.archived_at = now;
        }
        const edited = ['title', 'body', 'priority', 'expires_at'].some((k) => k in (values ?? {}));
        if (edited) {
          if (!['draft', 'published'].includes(next.status)) {
            return {
              data: null,
              error: { code: '42501', message: 'only draft or published announcements can be edited' },
            };
          }
          if (visible.status === 'published' && next.status === 'published') next.edited_at = now;
        }
        Object.assign(visible, next);
        return { data: [pick(visible, columns)], error: null };
      }
    }
    if (table === 'comments') {
      if (op === 'insert') {
        // can_comment_on(): published, visible post + comments.create; a parent must be a
        // published comment on the same post (comments trigger, 23503).
        const post = allPosts().find((row) => row.id === values?.post_id);
        const perms = post ? permissionsIn(post.community_id) : [];
        if (
          !post ||
          post.status !== 'published' ||
          !canViewPost(post) ||
          !perms.includes('comments.create')
        ) {
          return {
            data: null,
            error: {
              code: '42501',
              message: 'new row violates row-level security policy for table "comments"',
            },
          };
        }
        const parentId = (values?.parent_comment_id as string | null | undefined) ?? null;
        const parent = parentId ? allComments().find((row) => row.id === parentId) : undefined;
        if (parentId && (!parent || parent.post_id !== post.id || parent.status !== 'published')) {
          return { data: null, error: { code: '23503', message: 'parent comment not found on this post' } };
        }
        const latest = Math.max(Date.now(), ...allComments().map((row) => Date.parse(row.created_at) + 1000));
        const row: CommentRow = {
          ...makeComment(post.community_id, post.id, 0),
          id: `f6f6f6f6-0000-4000-8000-${String(++commentCount).padStart(12, '0')}`,
          parent_comment_id: parentId,
          depth: parent ? parent.depth + 1 : 0,
          author_user_id: user,
          author_display_name: profiles.get(user)?.display_name ?? null,
          body: String(values?.body),
          reaction_count: 0,
          created_at: new Date(latest).toISOString(),
        };
        const bucket = content[post.community_id] ?? {};
        content[post.community_id] = { ...bucket, comments: [...(bucket.comments ?? []), row] };
        return { data: pick(row, columns), error: null };
      }
      const target = allComments().find((row) => row.id === filters.find(([c]) => c === 'id')?.[1]);
      const visible = target && canViewComment(target) ? target : undefined;
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
            ? (own && perms.includes('comments.delete_own')) || perms.includes('comments.moderate')
            : 'body' in (values ?? {})
              ? own && perms.includes('comments.edit_own') && visible.status === 'published'
              : perms.includes('comments.moderate');
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
      const column =
        filters.some(([c]) => c === 'comment_id') || values?.comment_id ? 'comment_id' : 'post_id';
      const targetId = String(filters.find(([c]) => c === column)?.[1] ?? values?.[column]);
      const mine = reactions.find((r) => r.targetId === targetId && r.userId === user);
      if (op === 'select') {
        return {
          data: single ? (mine ? { id: mine.id } : null) : mine ? [{ id: mine.id }] : [],
          error: null,
        };
      }
      const target = reactionTarget(targetId);
      // can_react_to(): a published, visible target.
      if (!target || target.row.status !== 'published' || !target.visible) {
        return {
          data: null,
          error: {
            code: '42501',
            message: 'new row violates row-level security policy for table "reactions"',
          },
        };
      }
      const counts = typeCounts(target.row);
      if (op === 'insert') {
        // One reaction per user and target (unique index).
        if (mine)
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "reactions_one_per_user_post"',
            },
          };
        const type = String(values?.reaction_type);
        reactions.push({
          id: `e5e5e5e5-0000-4000-8000-${String(reactions.length + 1).padStart(12, '0')}`,
          targetId,
          userId: user,
          type,
        });
        counts[type] = (counts[type] ?? 0) + 1;
        target.row.reaction_count = Number(target.row.reaction_count) + 1;
        target.row.my_reaction_type = type;
        return { data: null, error: null };
      }
      if (op === 'update' && mine) {
        const type = String(values?.reaction_type);
        counts[mine.type] = (counts[mine.type] ?? 1) - 1;
        counts[type] = (counts[type] ?? 0) + 1;
        mine.type = type;
        target.row.my_reaction_type = type;
        return { data: null, error: null };
      }
      if (op === 'delete' && mine) {
        reactions.splice(reactions.indexOf(mine), 1);
        counts[mine.type] = (counts[mine.type] ?? 1) - 1;
        target.row.reaction_count = Number(target.row.reaction_count) - 1;
        target.row.my_reaction_type = null;
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
  const reactions: { id: string; targetId: string; userId: string; type: string }[] = [];
  let commentCount = 100;
  const allPosts = () => Object.values(content).flatMap((c) => c.posts ?? []) as PostRow[];
  const allComments = () => Object.values(content).flatMap((c) => c.comments ?? []) as CommentRow[];
  /** Other people's reactions per type (seeded as likes from reaction_count) plus the user's own. */
  const reactionCounts = new Map<string, Record<string, number>>();
  const typeCounts = (row: { id: string; reaction_count: number; my_reaction_type: string | null }) => {
    let counts = reactionCounts.get(row.id);
    if (!counts) {
      const others = Number(row.reaction_count) - (row.my_reaction_type ? 1 : 0);
      counts = others > 0 ? { like: others } : {};
      if (row.my_reaction_type) counts[row.my_reaction_type] = (counts[row.my_reaction_type] ?? 0) + 1;
      reactionCounts.set(row.id, counts);
    }
    return counts;
  };
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
  let alertCount = 500;
  /** private.can_view_alert_row(): drafts → manage, or own with create; otherwise view or manage. */
  const canViewAlert = (row: AlertRow) => {
    const perms = permissionsIn(row.community_id);
    if (row.status === 'draft') {
      return perms.includes('alerts.manage') || (row.created_by === me() && perms.includes('alerts.create'));
    }
    return perms.includes('alerts.view') || perms.includes('alerts.manage');
  };
  /** private.can_manage_alert_row(): manage any; your own with create. */
  const canManageAlert = (row: AlertRow) => {
    const perms = permissionsIn(row.community_id);
    return perms.includes('alerts.manage') || (row.created_by === me() && perms.includes('alerts.create'));
  };
  let announcementCount = 500;
  /** private.can_view_announcement_row(): published/archived → view or manage; else manage, or own with create. */
  const canViewAnnouncement = (row: AnnouncementRow) => {
    const perms = permissionsIn(row.community_id);
    if (row.status === 'published' || row.status === 'archived') {
      return perms.includes('announcements.view') || perms.includes('announcements.manage');
    }
    return (
      perms.includes('announcements.manage') ||
      (row.author_user_id === me() && perms.includes('announcements.create'))
    );
  };
  /** private.can_manage_announcement_row(): manage any; your own with create. */
  const canManageAnnouncement = (row: AnnouncementRow) => {
    const perms = permissionsIn(row.community_id);
    return (
      perms.includes('announcements.manage') ||
      (row.author_user_id === me() && perms.includes('announcements.create'))
    );
  };
  /** private.can_view_comment_row(): its post is visible, and published, or comments.moderate, or the author. */
  const canViewComment = (row: CommentRow) => {
    const post = allPosts().find((p) => p.id === row.post_id);
    if (!post || !canViewPost(post)) return false;
    return (
      row.status === 'published' ||
      permissionsIn(row.community_id).includes('comments.moderate') ||
      row.author_user_id === me()
    );
  };
  const reactionTarget = (targetId: string) => {
    const post = allPosts().find((row) => row.id === targetId);
    if (post) return { row: post as PostRow & { reaction_count: number }, visible: canViewPost(post) };
    const comment = allComments().find((row) => row.id === targetId);
    if (comment) {
      const parentPost = allPosts().find((row) => row.id === comment.post_id);
      return { row: comment, visible: canViewComment(comment) && parentPost?.status === 'published' };
    }
    return null;
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
      list_upcoming_events: 'events',
    };
    if (name === 'my_community_permissions') {
      return { data: permissionsIn(String(args.p_community_id)), error: null };
    }
    if (name === 'list_active_alerts' || name === 'list_alert_history') {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const now = Date.now();
      const active = (row: AlertRow) =>
        row.status === 'published' && (!row.expires_at || Date.parse(row.expires_at) > now);
      const rank = (row: AlertRow) => SEVERITY_RANK[row.severity] ?? row.severity_rank;
      const all = ((content[String(args.p_community_id)]?.alerts ?? []) as AlertRow[]).filter(canViewAlert);
      const newest = (a: string | null, b: string | null, aId: string, bId: string) =>
        a === b ? bId.localeCompare(aId) : String(b).localeCompare(String(a));
      let rows: Record<string, unknown>[];
      if (name === 'list_active_alerts') {
        // Published, not expired; emergencies first (severity rank), then newest.
        rows = all
          .filter(active)
          .sort((a, b) => rank(b) - rank(a) || newest(a.published_at, b.published_at, a.id, b.id))
          .map((row) => ({ ...row, severity_rank: rank(row) }));
      } else {
        const statuses = (args.p_statuses as string[] | undefined) ?? [
          'published',
          'expired',
          'cancelled',
          'archived',
        ];
        rows = all
          .filter((row) => statuses.includes(row.status))
          .map((row) => ({ ...row, is_active: active(row), sort_at: row.published_at ?? row.created_at }))
          .sort((a, b) => newest(a.sort_at, b.sort_at, a.id, b.id));
      }
      const after = args.p_cursor_id ? rows.findIndex((row) => row.id === args.p_cursor_id) + 1 : 0;
      return { data: rows.slice(after, after + Number(args.p_limit ?? 20)), error: null };
    }
    if (name === 'list_current_announcements' || name === 'list_announcement_history') {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const now = Date.now();
      const expired = (row: AnnouncementRow) => !!row.expires_at && Date.parse(row.expires_at) <= now;
      const all = ((content[String(args.p_community_id)]?.announcements ?? []) as AnnouncementRow[]).filter(
        canViewAnnouncement,
      );
      let rows: AnnouncementRow[];
      if (name === 'list_current_announcements') {
        // Published, not expired; important first, then newest.
        rows = all
          .filter((row) => row.status === 'published' && !expired(row))
          .sort((a, b) =>
            a.priority !== b.priority
              ? a.priority === 'important'
                ? -1
                : 1
              : b.published_at === a.published_at
                ? b.id.localeCompare(a.id)
                : String(b.published_at).localeCompare(String(a.published_at)),
          );
      } else {
        const statuses = (args.p_statuses as string[] | undefined) ?? ['published', 'archived'];
        rows = all
          .filter((row) => statuses.includes(row.status))
          .map((row) => ({ ...row, is_expired: expired(row), sort_at: row.published_at ?? row.created_at }))
          .sort((a, b) =>
            a.sort_at === b.sort_at
              ? b.id.localeCompare(a.id)
              : String(b.sort_at).localeCompare(String(a.sort_at)),
          );
      }
      const after = args.p_cursor_id ? rows.findIndex((row) => row.id === args.p_cursor_id) + 1 : 0;
      return {
        data: rows.slice(after, after + Number(args.p_limit ?? 20)).map((row) => ({ ...row })),
        error: null,
      };
    }
    if (name === 'list_post_comments') {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const parent = (args.p_parent_comment_id as string | undefined) ?? null;
      const cursor = args.p_cursor_created_at
        ? [String(args.p_cursor_created_at), String(args.p_cursor_id)]
        : null;
      const rows = allComments()
        .filter(
          (row) => row.post_id === args.p_post_id && row.parent_comment_id === parent && canViewComment(row),
        )
        .sort((a, b) =>
          a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
        )
        .filter(
          (row) =>
            !cursor || row.created_at > cursor[0]! || (row.created_at === cursor[0] && row.id > cursor[1]!),
        )
        .slice(0, Number(args.p_limit ?? 50))
        .map((row) => ({
          ...row,
          reply_count: allComments().filter((r) => r.parent_comment_id === row.id && r.status === 'published')
            .length,
        }));
      return { data: rows, error: null };
    }
    if (name === 'get_reaction_summary') {
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const rows: Record<string, unknown>[] = [];
      for (const [column, ids] of [
        ['post_id', args.p_post_ids],
        ['comment_id', args.p_comment_ids],
      ] as const) {
        for (const targetId of (ids as string[] | undefined) ?? []) {
          const target = reactionTarget(targetId);
          if (!target?.visible) continue;
          const counts = typeCounts(target.row);
          for (const [type, count] of Object.entries(counts).sort()) {
            if (count <= 0) continue;
            rows.push({
              post_id: column === 'post_id' ? targetId : null,
              comment_id: column === 'comment_id' ? targetId : null,
              reaction_type: type,
              reaction_count: count,
              reacted_by_me: target.row.my_reaction_type === type,
            });
          }
        }
      }
      return { data: rows, error: null };
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
  status: 'published',
  created_by: null as string | null,
  created_at: at(-n - 30),
  published_at: at(-n) as string | null,
  published_by: null as string | null,
  expires_at: null as string | null,
  expired_at: null as string | null,
  cancelled_at: null as string | null,
  cancellation_reason: null as string | null,
  archived_at: null as string | null,
  edited_at: null as string | null,
  updated_at: at(-n),
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
  author_user_id: null as string | null,
  published_at: at(-60 * n) as string | null,
  archived_at: null as string | null,
  created_at: at(-60 * n - 30),
  expires_at: null as string | null,
  edited_at: null as string | null,
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

export const makeComment = (
  communityId: string,
  postId: string,
  n: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `f6f6f6f6-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  post_id: postId,
  parent_comment_id: null as string | null,
  depth: 0,
  author_user_id: OTHER_USER_ID as string | null,
  author_display_name: 'Grace H.' as string | null,
  author_avatar_url: null as string | null,
  body: `Comment ${n}`,
  status: 'published',
  moderation_reason: null as string | null,
  edited_at: null as string | null,
  created_at: at(n),
  reply_count: 0,
  reaction_count: 0,
  my_reaction_type: null as string | null,
  ...overrides,
});

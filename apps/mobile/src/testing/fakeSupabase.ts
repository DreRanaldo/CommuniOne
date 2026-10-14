// A fake Supabase client for UI tests: in-memory auth with real event
// semantics (onAuthStateChange), scripted email links, canned RPC results,
// and the user's own profile, phone and avatar files with the backend's
// visibility rules (profile_private and avatars are the owner's only). Used with the REAL service layer, so screens are tested through
// the same code path as the app.
import type { PaymentBrowser } from '@/lib/paymentBrowser';
import type { Session } from '@supabase/supabase-js';
import { UploadError, type FileUploader } from '@communione/services';
import type { LinkSource } from '@/lib/links';
import type { CurrentPosition, LocationSource } from '@/lib/location';
import { createFakeMarket, type FakeMarketSeed } from './fakeMarket';
import type { MediaPicker, PickedFile, PickedImage } from '@/lib/media';
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
  /** The first call of this RPC fails with an internal error (e.g. the feed's first load). */
  failFirstRpcNamed?: string;
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
  /** Other members per community (see makeMember); the signed-in user is added from `communities`. */
  members?: Record<string, FakeMember[]>;
  /** Someone else can also manage roles (so an Owner may leave). */
  otherRoleManagers?: boolean;
  /** community_stats() overrides per community (unset counts are computed from content). */
  communityStats?: Record<string, Record<string, number | null>>;
  /** my_profile_stats() overrides. */
  profileStats?: Record<string, unknown>;
  /** document_upload_settings.max_file_size_bytes (default 25 MiB). */
  documentMaxBytes?: number;
  /** The signed-in user's notifications (see makeNotification). */
  notifications?: Record<string, unknown>[];
  /** Permission keys by community id; otherwise derived from the user's roles there. */
  permissions?: Record<string, string[]>;
  /** Marketplace catalog (see makeSellerProfile / makeListing in fakeMarket.ts). */
  market?: FakeMarketSeed;
}

export interface FakeContent {
  alerts?: Record<string, unknown>[];
  announcements?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  /** Event RSVPs (see makeRsvp). */
  rsvps?: Record<string, unknown>[];
  /** Post pictures (see makePostImage); their files exist in the post-images bucket. */
  postImages?: Record<string, unknown>[];
  /** Documents (see makeDocument). */
  documents?: Record<string, unknown>[];
  /** Stories as list_community_stories returns them (see makeStory). */
  stories?: Record<string, unknown>[];
  /** document_folders rows (see makeFolder). */
  folders?: Record<string, unknown>[];
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

/** A co-member as the database stores them (profile, private phone, membership). */
export type FakeMember = ReturnType<typeof makeMember>;

/** Default role permissions for posts (seed role templates). */
const MEMBER_PERMISSIONS = [
  'community.view',
  'members.view',
  'roles.view',
  'alerts.view',
  // Migration 31: members may send alerts (emergencies still need alerts.manage).
  'alerts.create',
  'announcements.view',
  'documents.view',
  'events.view',
  'posts.view',
  'posts.create',
  'posts.edit_own',
  'posts.delete_own',
  'comments.create',
  'comments.edit_own',
  'comments.delete_own',
  // Migration 32: members browse, buy and sell in their community's marketplace.
  'marketplace.view',
  'marketplace.buy',
  'marketplace.sell',
];
const MODERATION = ['posts.moderate', 'comments.moderate'];
const MANAGEMENT = [
  'marketplace.manage',
  'alerts.manage',
  'announcements.create',
  'announcements.manage',
  'documents.manage',
  'documents.upload',
  'events.create',
  'events.manage',
];
/** Membership management (seed: Admins and Owners; Moderators suspend only). */
const PEOPLE = ['members.invite', 'members.approve', 'members.suspend', 'members.remove', 'audit.view'];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  // Seed templates: Owners hold everything; Admins everything except roles.manage.
  Owner: [...MEMBER_PERMISSIONS, ...MODERATION, ...MANAGEMENT, ...PEOPLE, 'community.update', 'roles.manage'],
  Admin: [...MEMBER_PERMISSIONS, ...MODERATION, ...MANAGEMENT, ...PEOPLE, 'community.update'],
  Moderator: [...MEMBER_PERMISSIONS, ...MODERATION, 'members.suspend'],
  Member: MEMBER_PERMISSIONS,
};

type PostRow = ReturnType<typeof makePost>;
type CommentRow = ReturnType<typeof makeComment>;
type AnnouncementRow = ReturnType<typeof makeAnnouncement>;
type PostImageRow = ReturnType<typeof makePostImage>;
type NotificationRow = ReturnType<typeof makeNotification>;
type DocumentRow = ReturnType<typeof makeDocument>;
type FolderRow = ReturnType<typeof makeFolder>;
type StoryRow = ReturnType<typeof makeStory>;
/** document_mime_types (seeded allow-list). */
const DOCUMENT_TYPES: [string, string][] = [
  ['application/pdf', 'pdf'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
];
/** notification_types.requires_membership (seeded catalog). */
const MEMBERSHIP_TYPES = new Set([
  'announcement',
  'alert',
  'event_created',
  'event_updated',
  'event_cancelled',
  'comment',
]);
type AlertRow = ReturnType<typeof makeAlert>;
type EventRow = ReturnType<typeof makeEvent>;
type RsvpRow = ReturnType<typeof makeRsvp>;
const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, urgent: 3, emergency: 4 };
type Filter = [column: string, value: unknown];
/** A `.in(column, values)` filter. */
class InList {
  constructor(readonly values: unknown[]) {}
}
const filterMatches = (value: unknown, expected: unknown) =>
  expected instanceof InList ? expected.values.includes(value) : value === expected;

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
    const matches = (row: Record<string, unknown>) => filters.every(([c, v]) => filterMatches(row[c], v));
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
    if (table === 'notifications' && op === 'select') {
      const rows = notificationRows.filter(
        (row) => canReadNotification(row) && matches(row as unknown as Record<string, unknown>),
      );
      const picked = rows.map((row) => pick(row, columns));
      return { data: single ? (picked[0] ?? null) : picked, error: null };
    }
    if (table === 'documents') {
      // RLS: private.can_view_document_row (select), manager or own uploader (update).
      const visible = allDocuments().filter(
        (row) => canViewDocument(row) && matches(row as unknown as Record<string, unknown>),
      );
      if (op === 'select') {
        const picked = visible.map((row) => pick(row, columns));
        return { data: single ? (picked[0] ?? null) : picked, error: null };
      }
      if (op === 'update') {
        const writable = visible.filter((row) => canWriteDocument(row));
        for (const row of writable) {
          const refused = documentTrigger(row, values ?? {});
          if (refused) return { data: null, error: refused };
        }
        return { data: writable.map((row) => pick(row, columns)), error: null };
      }
    }
    if (table === 'document_folders' && op === 'select') {
      const rows = allFolders()
        .filter((row) => {
          const perms = permissionsIn(row.community_id);
          return (
            (perms.includes('documents.view') || perms.includes('documents.manage')) &&
            matches(row as unknown as Record<string, unknown>)
          );
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const picked = rows.map((row) => pick(row, columns));
      return { data: single ? (picked[0] ?? null) : picked, error: null };
    }
    if (table === 'document_upload_settings' && op === 'select') {
      const row = pick({ max_file_size_bytes: documentMaxBytes }, columns);
      return { data: single ? row : [row], error: null };
    }
    if (table === 'document_mime_types' && op === 'select') {
      const rows = DOCUMENT_TYPES.map(([mime_type, extension]) =>
        pick({ mime_type, extension, enabled: true }, columns),
      );
      return { data: rows, error: null };
    }
    if (table === 'post_images' && op === 'select') {
      // RLS: pictures of posts the caller can see.
      const rows = allPostImages()
        .filter((row) => {
          const post = allPosts().find((p) => p.id === row.post_id);
          return post && canViewPost(post) && matches(row as unknown as Record<string, unknown>);
        })
        .sort((a, b) => a.position - b.position)
        .map((row) => pick(row, columns));
      return { data: rows, error: null };
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
    if (table === 'events') {
      const now = new Date().toISOString();
      const invalid = (message: string) => ({ data: null, error: { code: '22023', message } });
      const denied = (message: string) => ({ data: null, error: { code: '42501', message } });
      if (op === 'insert') {
        // events_insert_authorized + enforce_event_write().
        const communityId = String(values?.community_id);
        const status = String(values?.status ?? 'draft');
        if (!permissionsIn(communityId).includes('events.create'))
          return denied('new row violates row-level security policy for table "events"');
        if (Date.parse(String(values?.ends_at)) < Date.parse(String(values?.starts_at)))
          return { data: null, error: { code: '23514', message: 'events_time_order' } };
        if (status === 'published' && Date.parse(String(values?.ends_at)) <= Date.now())
          return invalid('an event that has already ended cannot be published');
        const row: EventRow = {
          ...makeEvent(communityId, ++eventCount),
          title: String(values?.title),
          description: (values?.description as string | null) ?? null,
          location_text: (values?.location_text as string | null) ?? null,
          starts_at: String(values?.starts_at),
          ends_at: String(values?.ends_at),
          timezone: (values?.timezone as string | undefined) ?? 'UTC',
          capacity: (values?.capacity as number | null) ?? null,
          status,
          created_by: user,
          published_at: status === 'published' ? now : null,
          created_at: now,
          updated_at: now,
        };
        content[communityId] = {
          ...content[communityId],
          events: [...(content[communityId]?.events ?? []), row],
        };
        return { data: pick(row, columns), error: null };
      }
      const target = allEvents().find((row) => row.id === filters.find(([c]) => c === 'id')?.[1]);
      const visible = target && canViewEvent(target) ? target : undefined;
      if (op === 'select') {
        const rows = visible ? [pick(visible, columns)] : [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update') {
        if (!visible || !canManageEvent(visible)) return { data: [], error: null };
        const next = { ...visible, ...values } as EventRow;
        const going = rsvpsOf(visible).filter((r) => r.status === 'going').length;
        if (next.capacity !== visible.capacity && next.capacity !== null && next.capacity < going)
          return invalid(
            `capacity (${next.capacity}) cannot be lower than the number of people going (${going})`,
          );
        if (visible.status === 'cancelled' || visible.status === 'completed')
          return denied(`${visible.status} events cannot be modified`);
        if (next.status !== visible.status) {
          const allowed: Record<string, string[]> = {
            draft: ['published', 'cancelled'],
            published: ['cancelled', 'completed'],
          };
          if (!allowed[visible.status]?.includes(next.status))
            return invalid(`invalid event transition: ${visible.status} -> ${next.status}`);
          if (next.status === 'published') {
            if (Date.parse(next.ends_at) <= Date.now())
              return invalid('an event that has already ended cannot be published');
            next.published_at = now;
          }
          if (next.status === 'cancelled') next.cancelled_at = now;
          if (next.status === 'completed') {
            if (Date.parse(visible.starts_at) > Date.now())
              return invalid('an event cannot be completed before it starts');
            next.completed_at = now;
          }
        }
        if (
          next.cancellation_reason !== visible.cancellation_reason &&
          !(next.status === 'cancelled' && visible.status !== 'cancelled')
        )
          return invalid('a cancellation reason can only be given when cancelling');
        const edited = [
          'title',
          'description',
          'location_text',
          'starts_at',
          'ends_at',
          'timezone',
          'capacity',
        ].some(
          (k) =>
            k in (values ?? {}) &&
            (values as Record<string, unknown>)[k] !== (visible as Record<string, unknown>)[k],
        );
        if (edited) {
          if (!['draft', 'published'].includes(next.status))
            return denied('only draft or published events can be edited');
          if (Date.parse(next.ends_at) < Date.parse(next.starts_at))
            return { data: null, error: { code: '23514', message: 'events_time_order' } };
          if (visible.status === 'published') next.edited_at = now;
        }
        next.updated_at = now;
        Object.assign(visible, next);
        promoteWaitlist(visible); // on_event_capacity_change()
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
        // Migration 31: location complete and in range; the photo is the sender's own upload here.
        const lat = values?.latitude as number | null | undefined;
        const lng = values?.longitude as number | null | undefined;
        if ((lat == null) !== (lng == null) || (lat != null && (Math.abs(lat) > 90 || Math.abs(lng!) > 180)))
          return {
            data: null,
            error: { code: '23514', message: 'new row violates check constraint "alerts_location_complete"' },
          };
        const imagePath = (values?.image_path as string | null | undefined) ?? null;
        if (imagePath) {
          const [folderCommunity, folderUser] = imagePath.split('/');
          if (folderCommunity !== communityId || folderUser !== user)
            return denied('the photo must be your own upload for this community');
          if (!alertImageFiles.has(imagePath)) return invalid('the photo was not uploaded');
        }
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
          latitude: lat ?? null,
          longitude: lng ?? null,
          location_accuracy_m: (values?.location_accuracy_m as number | null | undefined) ?? null,
          image_path: imagePath,
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
          // Migration 30: taking a published alert down (or archiving) needs alerts.manage.
          if (visible.status !== 'draft' && !manager)
            return denied('ending, cancelling or archiving a published alert requires alerts.manage');
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
        // Column grants: slug and status are never client-writable.
        if (values && ('slug' in values || 'status' in values))
          return { data: null, error: { code: '42501', message: 'permission denied for table communities' } };
        // private.validate_community_timezone()
        if (typeof values?.timezone === 'string') {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: values.timezone }).format(0);
          } catch {
            return { data: null, error: { code: '22023', message: `unknown time zone: ${values.timezone}` } };
          }
        }
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
    if (table === 'memberships') {
      // RLS (migration 10): your own rows; others' ACTIVE rows with members.view,
      // other statuses with members.approve / suspend / remove.
      const visibleRows = membershipRows().filter(
        (r) => r.user_id === user || canViewMembership(r.community_id, r.status),
      );
      const shaped = (r: MembershipRow) => {
        const { member: _m, ...row } = r;
        return columns.includes('(') ? row : pick(row, columns);
      };
      const targets = visibleRows.filter((row) => matches({ ...row }));
      if (op === 'select') {
        const rows = targets.map(shaped);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (op === 'update' && values && 'status' in values) {
        const next = String(values.status);
        const updated: MembershipRow[] = [];
        for (const row of targets) {
          if (row.user_id === user) {
            // private.enforce_membership_update: leaving is the only self-change.
            if (next !== 'left') return denied(`you cannot change your own membership status to ${next}`);
            // private.is_sole_role_manager: the last member able to manage roles cannot leave.
            if (permissionsIn(row.community_id).includes('roles.manage') && !options.otherRoleManagers)
              return denied('the last member able to manage roles cannot leave the community');
            communities = communities.filter(
              (c) => (c as { membership_id: string }).membership_id !== row.id,
            );
            updated.push({ ...row, status: 'left' });
            continue;
          }
          const perms = permissionsIn(row.community_id);
          // RLS USING: members.approve or members.suspend, else the row is not updatable (0 rows).
          if (!perms.includes('members.approve') && !perms.includes('members.suspend')) continue;
          if (!covers(row.community_id, permissionsOfRoles(row.member.role_names)))
            return denied('insufficient privileges to modify this membership');
          const from = row.status;
          const approval =
            (['pending', 'rejected', 'left'].includes(from) && next === 'active') ||
            (from === 'pending' && next === 'rejected');
          const suspension =
            (from === 'active' && next === 'suspended') || (from === 'suspended' && next === 'active');
          if (!approval && !suspension)
            return {
              data: null,
              error: { code: '22023', message: `invalid membership status transition: ${from} -> ${next}` },
            };
          if (
            (approval && !perms.includes('members.approve')) ||
            (suspension && !perms.includes('members.suspend'))
          )
            return denied(`insufficient privileges for membership transition ${from} -> ${next}`);
          const m = row.member;
          m.status = next;
          // Stage 3 lifecycle: admission assigns the default role; rejection removes roles.
          if (next === 'active' && m.role_names.length === 0) m.role_names = ['Member'];
          if (next === 'rejected') m.role_names = [];
          if (next === 'active' && !m.joined_at) m.joined_at = new Date().toISOString();
          updated.push(membershipRow(row.community_id, m));
        }
        return { data: updated.map(shaped), error: null };
      }
      if (op === 'delete') {
        // RLS: members.remove, never your own row, and the actor covers the member.
        const removed = targets.filter(
          (row) =>
            row.user_id !== user &&
            permissionsIn(row.community_id).includes('members.remove') &&
            covers(row.community_id, permissionsOfRoles(row.member.role_names)),
        );
        for (const row of removed) {
          const list = memberRows[row.community_id] ?? [];
          memberRows[row.community_id] = list.filter((m) => m.membership_id !== row.id);
        }
        return { data: removed.map(shaped), error: null };
      }
    }
    if (table === 'roles' && op === 'select') {
      // RLS: roles.view in the role's community.
      const rows = rolesOf()
        .filter((r) => permissionsIn(r.community_id).includes('roles.view'))
        .filter((r) => matches({ ...r }))
        .map((r) => pick(r, columns));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    if (table === 'membership_roles') {
      const membershipId = (values?.membership_id ??
        filters.find(([c]) => c === 'membership_id')?.[1]) as string;
      const roleId = (values?.role_id ?? filters.find(([c]) => c === 'role_id')?.[1]) as string;
      const target = membershipRows().find((r) => r.id === membershipId);
      const role = rolesOf().find((r) => r.id === roleId);
      // RLS (Stage 1): roles.manage, never your own membership, and the actor
      // covers both the member and the role (no privilege escalation).
      const allowed =
        !!target &&
        !!role &&
        role.community_id === target.community_id &&
        permissionsIn(target.community_id).includes('roles.manage') &&
        target.user_id !== user &&
        covers(target.community_id, permissionsOfRoles(target.member.role_names)) &&
        covers(target.community_id, ROLE_PERMISSIONS[role.name] ?? []);
      const has = !!target && !!role && target.member.role_names.includes(role.name);
      if (op === 'insert') {
        if (!allowed)
          return denied('new row violates row-level security policy for table "membership_roles"');
        if (has)
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        target.member.role_names = [...target.member.role_names, role.name];
        return { data: null, error: null };
      }
      if (op === 'delete') {
        if (!allowed || !has) return { data: [], error: null };
        target.member.role_names = target.member.role_names.filter((n) => n !== role.name);
        return { data: [{ id: `${membershipId}:${roleId}` }], error: null };
      }
      if (op === 'select') {
        const visible =
          has && (target.user_id === user || canViewMembership(target.community_id, target.status));
        return { data: visible ? [{ id: `${membershipId}:${roleId}` }] : [], error: null };
      }
    }
    const marketResult = market.query(table, op, filters, columns, values, single, matches);
    if (marketResult) return marketResult;
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
      in(column: string, list: unknown[]) {
        filters.push([column, new InList(list)]);
        return builder;
      },
      // Keyset pagination (memberships.list); every row fits on one test page.
      or(_expression: string) {
        return builder;
      },
      order(_column: string) {
        return builder;
      },
      limit(_count: number) {
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
    createSignedUrls: jest.fn(async (paths: string[], seconds: number) => ({
      data: paths.map((path) =>
        files.has(path) && me()
          ? { path, signedUrl: `https://storage.test/avatars/${path}?expires=${seconds}`, error: null }
          : { path, signedUrl: '', error: 'Object not found' },
      ),
      error: null,
    })),
  };
  // ---- Storage: the private documents bucket (Stage 10 storage policies) ----
  const documentFiles = new Map<string, { size: number; mimetype: string }>(); // path → stored object
  const documentByPath = (path: string) => allDocuments().find((d) => d.storage_path === path);
  const documentsBucket = {
    /** private.can_read_document_object: an exact path of a document the caller may see. */
    createSignedUrl: jest.fn(async (path: string, seconds: number) => {
      const doc = documentByPath(path);
      const readable =
        doc &&
        documentFiles.has(path) &&
        (['active', 'archived'].includes(doc.status) || doc.status === 'pending_upload') &&
        canViewDocument(doc);
      return readable
        ? { data: { signedUrl: `https://storage.test/documents/${path}?expires=${seconds}` }, error: null }
        : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    }),
    /** private.can_upload_document_object: the caller's own pending upload, still with documents.upload. No overwrite. */
    upload: jest.fn(
      async (
        path: string,
        body: { byteLength?: number; size?: number },
        opts: { contentType?: string } = {},
      ) => {
        const doc = documentByPath(path);
        const allowed =
          doc &&
          doc.status === 'pending_upload' &&
          doc.uploaded_by === me() &&
          permissionsIn(doc.community_id).includes('documents.upload');
        if (!allowed)
          return {
            data: null,
            error: { message: 'new row violates row-level security policy', statusCode: '403' },
          };
        if (documentFiles.has(path))
          return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
        documentFiles.set(path, {
          size: Number(body.byteLength ?? body.size ?? 0),
          mimetype: opts.contentType ?? '',
        });
        return { data: { path }, error: null };
      },
    ),
    /** private.can_delete_document_object: only a pending upload's file, by its uploader or a manager. */
    remove: jest.fn(async (paths: string[]) => {
      const removed = paths.filter((path) => {
        const doc = documentByPath(path);
        return (
          doc &&
          doc.status === 'pending_upload' &&
          (doc.uploaded_by === me() || permissionsIn(doc.community_id).includes('documents.manage')) &&
          documentFiles.delete(path)
        );
      });
      return { data: removed.map((name) => ({ name })), error: null };
    }),
  };
  // The app's upload transport (lib/uploader.ts) in tests: same policies as the bucket,
  // with progress, failures (failDocumentUploads) and a hold for cancelling mid-transfer.
  let documentUploadFailures = 0;
  let holdDocumentUploads = false;
  let releaseHeld: (() => void) | null = null;
  const uploadFile = jest.fn<Promise<void>, Parameters<FileUploader>>(
    async ({ bucket, path, body, contentType, onProgress, signal }) => {
      if (bucket !== 'documents') throw new UploadError('Unknown bucket', 400);
      const total = body instanceof Blob ? body.size : body.byteLength;
      if (signal?.aborted) throw new UploadError('The upload was cancelled.', 0, true);
      onProgress?.(0, total);
      onProgress?.(Math.round(total / 2), total);
      if (documentUploadFailures > 0) {
        documentUploadFailures -= 1;
        throw new UploadError('Network request failed', 0);
      }
      if (holdDocumentUploads) {
        await new Promise<void>((resolve, reject) => {
          releaseHeld = resolve;
          signal?.addEventListener('abort', () =>
            reject(new UploadError('The upload was cancelled.', 0, true)),
          );
        });
      }
      const stored = await documentsBucket.upload(path, body as { byteLength: number }, { contentType });
      if (stored.error) throw new UploadError(stored.error.message, Number(stored.error.statusCode));
      onProgress?.(total, total);
    },
  );
  // ---- Storage: the private post-images bucket ({community}/{user}/{file}; migration 26) ----
  const postImageFiles = new Map<string, string>(); // path → uploader
  let uploadFailures = 0;
  const canReadPostImage = (path: string) =>
    postImageFiles.get(path) === me() ||
    allPostImages().some((row) => {
      if (row.storage_path !== path) return false;
      const post = allPosts().find((p) => p.id === row.post_id);
      return !!post && canViewPost(post);
    });
  const postImagesBucket = {
    upload: jest.fn(async (path: string, _body: unknown, _options?: unknown) => {
      if (offline || uploadFailures > 0) {
        if (uploadFailures > 0) uploadFailures -= 1;
        return { data: null, error: { message: 'Network request failed' } };
      }
      const user = me();
      const [communityId, owner] = path.split('/');
      if (!user || owner !== user || !permissionsIn(communityId ?? '').includes('posts.create')) {
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      }
      postImageFiles.set(path, user);
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      // Policy: your own files, only while no post uses them.
      for (const path of paths) {
        if (postImageFiles.get(path) === me() && !allPostImages().some((row) => row.storage_path === path))
          postImageFiles.delete(path);
      }
      return { data: [], error: null };
    }),
    createSignedUrls: jest.fn(async (paths: string[], seconds: number) => ({
      data: paths.map((path) =>
        postImageFiles.has(path) && canReadPostImage(path)
          ? { path, signedUrl: `https://storage.test/post-images/${path}?expires=${seconds}`, error: null }
          : { path, signedUrl: '', error: 'Object not found' },
      ),
      error: null,
    })),
  };
  // ---- Storage: the private alert-images bucket (migration 31) ----
  const alertImageFiles = new Map<string, string>(); // path → uploader
  const allAlerts = () => Object.values(content).flatMap((c) => c.alerts ?? []) as AlertRow[];
  const alertImagesBucket = {
    upload: jest.fn(async (path: string, _body: unknown, _options?: unknown) => {
      if (offline || uploadFailures > 0) {
        if (uploadFailures > 0) uploadFailures -= 1;
        return { data: null, error: { message: 'Network request failed' } };
      }
      const user = me();
      const [communityId, owner] = path.split('/');
      if (!user || owner !== user || !permissionsIn(communityId ?? '').includes('alerts.create'))
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      alertImageFiles.set(path, user);
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      // Policy: your own files, only while no alert uses them.
      for (const path of paths)
        if (alertImageFiles.get(path) === me() && !allAlerts().some((a) => a.image_path === path))
          alertImageFiles.delete(path);
      return { data: [], error: null };
    }),
    // private.can_read_alert_image_object: whoever can see an alert using it, or the uploader.
    createSignedUrl: jest.fn(async (path: string, seconds: number) => {
      const used = allAlerts().find((a) => a.image_path === path);
      const readable =
        alertImageFiles.has(path) && ((used && canViewAlert(used)) || alertImageFiles.get(path) === me());
      return readable
        ? { data: { signedUrl: `https://storage.test/alert-images/${path}?expires=${seconds}` }, error: null }
        : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    }),
  };
  // ---- Storage: the public community-media bucket (community managers only) ----
  const mediaFiles = new Set<string>();
  /** community.update (RLS on communities and the community-media storage policies). */
  const manages = (communityId: string) => permissionsIn(communityId).includes('community.update');
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
    from: jest.fn((bucket: string) =>
      bucket === 'community-media'
        ? mediaBucket
        : bucket === 'post-images'
          ? postImagesBucket
          : bucket === 'documents'
            ? documentsBucket
            : bucket === 'alert-images'
              ? alertImagesBucket
              : bucket === 'listing-images'
                ? market.bucket
                : bucket === 'stories'
                  ? storiesBucket
                  : storageBucket,
    ),
  };
  if (options.profile?.avatar_path) files.add(options.profile.avatar_path);

  let communities = options.communities ?? [];
  communities.forEach((c) => addCommunityRow(c as Record<string, unknown>));
  const invitations = new Map(Object.entries(options.invitations ?? {}));
  const redemptions: { token: string; userId: string }[] = [];
  const content: Record<string, FakeContent> = { ...options.content };
  const allPostImages = () => Object.values(content).flatMap((c) => c.postImages ?? []) as PostImageRow[];
  // Seeded pictures' files exist, unless a row says its file is missing (`file_missing: true`).
  for (const row of allPostImages())
    if (!(row as { file_missing?: boolean }).file_missing)
      postImageFiles.set(row.storage_path, row.uploaded_by ?? 'seed');
  const rpcFailures = new Map<string, DbError>();
  if (options.failFirstRpcNamed)
    rpcFailures.set(options.failFirstRpcNamed, {
      code: 'XX000',
      message: 'internal error at /var/lib/postgresql',
    });
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
  let postImageCount = 500;
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
  // ---- Marketplace catalog (migration 32): see fakeMarket.ts ----
  const market = createFakeMarket(options.market ?? {}, { me, permissionsIn });
  // ---- Notifications: the user's own inbox (private.can_read_notification) ----
  const notificationRows = (options.notifications ?? []).map((row) => ({ ...row })) as NotificationRow[];
  const isActiveMember = (communityId: string) =>
    communities.some(
      (c) =>
        (c as { community_id: string }).community_id === communityId &&
        (c as { membership_status: string }).membership_status === 'active',
    );
  const canReadNotification = (row: NotificationRow) =>
    row.user_id === me() &&
    (row.community_id === null || !MEMBERSHIP_TYPES.has(row.type) || isActiveMember(row.community_id));
  // ---- Per-community notification preferences (migration 29) ----
  const notificationSettings = new Map<
    string,
    { announcements: boolean; events: boolean; comments: boolean; alerts: boolean }
  >();
  // ---- Member directory (migration 28): other members + the signed-in user ----
  const memberRows = options.members ?? {};
  for (const list of Object.values(memberRows))
    for (const m of list) if (m.phone) phones.set(m.user_id, m.phone);
  const membersOf = (communityId: string): FakeMember[] => {
    const mine = communities.find((c) => (c as { community_id: string }).community_id === communityId) as
      | { membership_id: string; membership_status: string; role_names: string[]; joined_at: string }
      | undefined;
    const profile = profiles.get(me() ?? '');
    const self =
      mine && profile
        ? [
            makeMember(0, {
              membership_id: mine.membership_id,
              user_id: me()!,
              display_name: profile.display_name,
              first_name: profile.first_name,
              last_name: profile.last_name,
              bio: profile.bio,
              avatar_path: null,
              role_names: mine.role_names,
              joined_at: mine.joined_at,
              status: mine.membership_status,
            }),
          ]
        : [];
    return [...self, ...(memberRows[communityId] ?? [])];
  };
  // ---- Member management (RN-16): memberships, roles, membership_roles ----
  type MembershipRow = ReturnType<typeof membershipRow>;
  const ROLE_NAMES = ['Admin', 'Member', 'Moderator', 'Owner'];
  /** A stable role id per community and template name. */
  const roleIdOf = (communityId: string, name: string) =>
    `f0f0f0f0-000${ROLE_NAMES.indexOf(name) + 1}-4000-8000-${communityId.slice(-12)}`;
  const membershipRow = (communityId: string, m: FakeMember) => ({
    id: m.membership_id,
    community_id: communityId,
    user_id: m.user_id,
    status: m.status,
    joined_at: m.joined_at,
    created_at: m.joined_at ?? '2025-01-01T00:00:00Z',
    profiles: { display_name: m.display_name, avatar_url: m.avatar_url },
    membership_roles: [...m.role_names]
      .sort()
      .map((name) => ({ roles: { id: roleIdOf(communityId, name), name } })),
    member: m,
  });
  const membershipRows = () => {
    const ids = new Set([
      ...communities.map((c) => (c as { community_id: string }).community_id),
      ...Object.keys(memberRows),
    ]);
    return [...ids].flatMap((id) => membersOf(id).map((m) => membershipRow(id, m)));
  };
  const rolesOf = () =>
    [...new Set(communities.map((c) => (c as { community_id: string }).community_id))].flatMap((id) =>
      ROLE_NAMES.map((name) => ({
        id: roleIdOf(id, name),
        community_id: id,
        name,
        description: null as string | null,
        is_system_role: true,
        is_default_for_new_members: name === 'Member',
      })),
    );
  /** private.can_view_membership. */
  const canViewMembership = (communityId: string, status: string) => {
    const perms = permissionsIn(communityId);
    return status === 'active'
      ? perms.includes('members.view')
      : ['members.approve', 'members.suspend', 'members.remove'].some((k) => perms.includes(k));
  };
  const permissionsOfRoles = (names: string[]) => [
    ...new Set(names.flatMap((n) => ROLE_PERMISSIONS[n] ?? [])),
  ];
  /** private.current_user_covers_*: the caller holds every one of these permissions. */
  const covers = (communityId: string, needed: string[]) => {
    const mine = permissionsIn(communityId);
    return needed.every((k) => mine.includes(k));
  };
  const denied = (message: string) => ({ data: null, error: { code: '42501', message } });
  // ---- Invitations created in the app (create / list / revoke) ----
  const createdInvitations: {
    id: string;
    community_id: string;
    created_by: string;
    expires_at: string;
    max_uses: number | null;
    use_count: number;
    status: string;
    created_at: string;
    token: string;
  }[] = [];
  // ---- Stories (migration 27 rules) ----
  const allStories = () => Object.values(content).flatMap((c) => c.stories ?? []) as StoryRow[];
  const storyFiles = new Set<string>(); // uploaded story pictures
  const storyViews = new Set<string>(); // `${storyId}:${userId}`
  /** private.can_view_story_row. */
  const canViewStory = (row: StoryRow) =>
    !row.deleted_at &&
    Date.parse(row.expires_at) > Date.now() &&
    (permissionsIn(row.community_id).includes('posts.view') ||
      (row.author_user_id === me() && permissionsIn(row.community_id).includes('posts.create')));
  const storyFolder = (path: string) => {
    const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(jpg|png|webp)$/.exec(path);
    return m ? { communityId: m[1]!, userId: m[2]! } : null;
  };
  const storiesBucket = {
    upload: jest.fn(async (path: string) => {
      const folder = storyFolder(path);
      if (!folder || folder.userId !== me() || !permissionsIn(folder.communityId).includes('posts.create'))
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      if (storyFiles.has(path))
        return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
      storyFiles.add(path);
      return { data: { path }, error: null };
    }),
    createSignedUrls: jest.fn(async (paths: string[], seconds: number) => ({
      data: paths.map((path) => {
        const story = allStories().find((st) => st.storage_path === path);
        const readable =
          storyFiles.has(path) && (story ? canViewStory(story) : storyFolder(path)?.userId === me());
        return readable
          ? { path, signedUrl: `https://storage.test/stories/${path}?expires=${seconds}`, error: null }
          : { path, signedUrl: '', error: 'Object not found' };
      }),
      error: null,
    })),
    remove: jest.fn(async (paths: string[]) => {
      const removed = paths.filter(
        (path) =>
          storyFolder(path)?.userId === me() &&
          !allStories().some((st) => st.storage_path === path) &&
          storyFiles.delete(path),
      );
      return { data: removed.map((name) => ({ name })), error: null };
    }),
  };
  let storyCount = 700;
  // ---- Documents (Stage 10 rules) ----
  const documentMaxBytes = options.documentMaxBytes ?? 25 * 1024 * 1024;
  const allDocuments = () => Object.values(content).flatMap((c) => c.documents ?? []) as DocumentRow[];
  const allFolders = () => Object.values(content).flatMap((c) => c.folders ?? []) as FolderRow[];
  /** private.can_view_document_row. */
  const canViewDocument = (row: DocumentRow) => {
    const perms = permissionsIn(row.community_id);
    const manager = perms.includes('documents.manage');
    if (row.status === 'active')
      return row.visibility === 'managers' ? manager : manager || perms.includes('documents.view');
    if (row.status === 'archived') return manager;
    return manager || (row.uploaded_by === me() && perms.includes('documents.upload'));
  };
  /** documents_update_authorized: a manager, or the uploader holding documents.upload. */
  const canWriteDocument = (row: DocumentRow) => {
    const perms = permissionsIn(row.community_id);
    return (
      perms.includes('documents.manage') || (row.uploaded_by === me() && perms.includes('documents.upload'))
    );
  };
  /** private.enforce_document_write: applies the change or returns the refusal. */
  const documentTrigger = (row: DocumentRow, values: Record<string, unknown>): DbError | null => {
    const manager = permissionsIn(row.community_id).includes('documents.manage');
    const immutable = [
      'community_id',
      'uploaded_by',
      'mime_type',
      'file_extension',
      'file_size',
      'storage_path',
    ];
    if (immutable.some((k) => k in values && values[k] !== (row as Record<string, unknown>)[k]))
      return { code: '42501', message: 'document community, uploader and file identity are immutable' };
    if (row.status === 'deleted') return { code: '42501', message: 'deleted documents cannot be modified' };
    const next = { ...row } as DocumentRow;
    if ('status' in values && values.status !== row.status) {
      const to = values.status as string;
      const archiveMove =
        (row.status === 'active' && to === 'archived') || (row.status === 'archived' && to === 'active');
      if (archiveMove && !manager) return { code: '42501', message: 'archiving requires documents.manage' };
      if (!archiveMove && to !== 'deleted')
        return { code: '22023', message: `invalid document transition: ${row.status} -> ${to}` };
      next.status = to;
      const now = new Date().toISOString();
      if (to === 'archived') next.archived_at = now;
      if (to === 'active') next.archived_at = null;
      if (to === 'deleted') next.deleted_at = now;
    }
    if ('visibility' in values && values.visibility !== row.visibility) {
      if (!manager) return { code: '42501', message: 'changing visibility requires documents.manage' };
      next.visibility = values.visibility as string;
    }
    if ('name' in values) {
      const name = String(values.name).split(/[\\/]/).pop()!.trim();
      if (!name || /^\.+$/.test(name)) return { code: '22023', message: 'invalid document name' };
      next.name = name;
    }
    if ('folder_id' in values) {
      const folder = values.folder_id as string | null;
      if (folder && !allFolders().some((f) => f.id === folder && f.community_id === row.community_id))
        return { code: '23503', message: 'insert or update violates foreign key constraint' };
      next.folder_id = folder;
    }
    Object.assign(row, next, { updated_at: new Date().toISOString(), updated_by_user_id: me() });
    return null;
  };
  let documentCount = 900;
  // Seeded stories have their pictures.
  for (const story of allStories()) storyFiles.add(story.storage_path);
  // Seeded documents (not pending or deleted) have their files.
  for (const doc of allDocuments())
    if (['active', 'archived'].includes(doc.status) && doc.storage_path)
      documentFiles.set(doc.storage_path, { size: doc.file_size, mimetype: doc.mime_type });
  let eventCount = 500;
  const allEvents = () => Object.values(content).flatMap((c) => c.events ?? []) as EventRow[];
  /** private.can_view_event_row(): drafts → manage, or own with create; otherwise view or manage. */
  const canViewEvent = (row: EventRow) => {
    const perms = permissionsIn(row.community_id);
    if (row.status === 'draft') {
      return perms.includes('events.manage') || (row.created_by === me() && perms.includes('events.create'));
    }
    return perms.includes('events.view') || perms.includes('events.manage');
  };
  /** private.can_manage_event_row(): manage any; your own with create. */
  const canManageEvent = (row: EventRow) => {
    const perms = permissionsIn(row.community_id);
    return perms.includes('events.manage') || (row.created_by === me() && perms.includes('events.create'));
  };
  /** private.can_rsvp(): published, not started, events.view in its community. */
  const canRsvp = (row: EventRow) =>
    row.status === 'published' &&
    Date.parse(row.starts_at) > Date.now() &&
    permissionsIn(row.community_id).includes('events.view');
  const rsvpsOf = (event: EventRow) =>
    ((content[event.community_id]?.rsvps ?? []) as RsvpRow[]).filter((r) => r.event_id === event.id);
  let rsvpClock = 0;
  /** FIFO promotion while places are free (apply_rsvp_capacity / on_event_capacity_change). */
  const promoteWaitlist = (event: EventRow) => {
    const rows = rsvpsOf(event);
    const waiting = rows
      .filter((r) => r.status === 'waitlisted')
      .sort(
        (a, b) => String(a.waitlisted_at).localeCompare(String(b.waitlisted_at)) || a.id.localeCompare(b.id),
      );
    let going = rows.filter((r) => r.status === 'going').length;
    for (const row of waiting) {
      if (event.capacity !== null && going >= event.capacity) break;
      row.status = 'going';
      row.waitlisted_at = null;
      going += 1;
    }
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
    const marketRpc = market.rpc(name, args);
    if (marketRpc) return offline ? { data: null, error: OFFLINE } : marketRpc;
    if (name === 'list_community_stories') {
      if (offline) return { data: null, error: OFFLINE };
      const visible = allStories().filter(
        (st) => st.community_id === args.p_community_id && canViewStory(st),
      );
      const seen = (st: StoryRow) => storyViews.has(`${st.id}:${me()}`) || st.viewed_by_me === true;
      const byAuthor = new Map<string, StoryRow[]>();
      for (const st of visible)
        byAuthor.set(st.author_user_id, [...(byAuthor.get(st.author_user_id) ?? []), st]);
      const groups = [...byAuthor.entries()].sort(([a, x], [b, y]) => {
        const mine = Number(b === me()) - Number(a === me());
        if (mine) return mine;
        const unseen = Number(x.every(seen)) - Number(y.every(seen));
        if (unseen) return unseen;
        const latest = (rows: StoryRow[]) =>
          rows
            .map((r) => r.created_at)
            .sort()
            .at(-1)!;
        return latest(y).localeCompare(latest(x));
      });
      const rows = groups.flatMap(([, list]) =>
        [...list]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((st) => ({
            ...st,
            viewed_by_me: seen(st),
            view_count:
              st.author_user_id === me()
                ? [...storyViews].filter((v) => v.startsWith(`${st.id}:`) && !v.endsWith(`:${me()}`)).length +
                  (st.view_count ?? 0)
                : null,
          })),
      );
      return { data: rows, error: null };
    }
    if (name === 'create_story') {
      if (offline) return { data: null, error: OFFLINE };
      const communityId = String(args.p_community_id);
      if (!me() || !permissionsIn(communityId).includes('posts.create'))
        return {
          data: null,
          error: { code: '42501', message: 'posts.create is required to add a story in this community' },
        };
      const request = args.p_client_request_id as string | undefined;
      const existing = request
        ? allStories().find((st) => st.author_user_id === me() && st.client_request_id === request)
        : undefined;
      if (existing) return { data: [{ ...existing }], error: null };
      const path = String(args.p_path);
      const folder = storyFolder(path);
      if (folder?.communityId !== communityId || folder.userId !== me())
        return {
          data: null,
          error: {
            code: '42501',
            message: 'a story picture must be uploaded to your own folder of this community',
          },
        };
      if (!storyFiles.has(path))
        return {
          data: null,
          error: { code: '22023', message: 'story picture not found; upload the picture first' },
        };
      const caption = (args.p_caption as string | undefined)?.trim() || null;
      if (caption && caption.length > 200)
        return {
          data: null,
          error: { code: '22023', message: 'a story caption can be at most 200 characters' },
        };
      storyCount += 1;
      const profile = profiles.get(me()!);
      const row = makeStory(communityId, storyCount, {
        author_user_id: me(),
        author_display_name: profile?.display_name ?? null,
        storage_path: path,
        caption,
        width: Number(args.p_width),
        height: Number(args.p_height),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        client_request_id: request ?? null,
      });
      content[communityId] = {
        ...content[communityId],
        stories: [...(content[communityId]?.stories ?? []), row],
      };
      return { data: [{ ...row }], error: null };
    }
    if (name === 'mark_story_viewed') {
      const story = allStories().find((st) => st.id === args.p_story_id);
      if (!story || !canViewStory(story)) return { data: false, error: null };
      storyViews.add(`${story.id}:${me()}`);
      return { data: true, error: null };
    }
    if (name === 'delete_story') {
      const story = allStories().find((st) => st.id === args.p_story_id);
      if (!story || !canViewStory(story)) return { data: false, error: null };
      if (story.author_user_id !== me() && !permissionsIn(story.community_id).includes('posts.moderate'))
        return {
          data: null,
          error: { code: '42501', message: 'only the author or a moderator can delete a story' },
        };
      story.deleted_at = new Date().toISOString();
      return { data: true, error: null };
    }
    if (name === 'community_stats') {
      if (offline) return { data: null, error: OFFLINE };
      const communityId = String(args.p_community_id);
      const perms = permissionsIn(communityId);
      if (!perms.length)
        return { data: null, error: { code: '42501', message: 'not a member of this community' } };
      const c = content[communityId] ?? {};
      const now = Date.now();
      const count = (
        perm: string,
        rows: Record<string, unknown>[] | undefined,
        keep: (r: Record<string, unknown>) => boolean,
      ) => (perms.includes(perm) ? (rows ?? []).filter(keep).length : null);
      const active = (r: Record<string, unknown>) =>
        r.status === 'published' && (!r.expires_at || Date.parse(String(r.expires_at)) > now);
      const computed = {
        member_count: 12,
        posts_today: count(
          'posts.view',
          c.posts,
          (r) => r.status === 'published' && now - Date.parse(String(r.created_at)) < 86_400_000,
        ),
        current_announcements: count('announcements.view', c.announcements, active),
        active_alerts: count('alerts.view', c.alerts, active),
        upcoming_events: count(
          'events.view',
          c.events,
          (r) => r.status === 'published' && Date.parse(String(r.ends_at)) > now,
        ),
        document_count:
          perms.includes('documents.view') || perms.includes('documents.manage')
            ? (c.documents ?? []).filter(
                (r) =>
                  r.status === 'active' && (r.visibility === 'members' || perms.includes('documents.manage')),
              ).length
            : null,
      };
      return { data: [{ ...computed, ...options.communityStats?.[communityId] }], error: null };
    }
    if (name === 'my_profile_stats') {
      if (offline) return { data: null, error: OFFLINE };
      return {
        data: [
          {
            communities: communities.filter(
              (c) => (c as { membership_status: string }).membership_status === 'active',
            ).length,
            posts: allPosts().filter((p) => p.author_user_id === me() && p.status === 'published').length,
            events_going: 0,
            member_since: '2024-03-05T12:00:00Z',
            ...options.profileStats,
          },
        ],
        error: null,
      };
    }
    if (name === 'my_community_notification_settings' || name === 'set_community_notification_settings') {
      if (offline) return { data: null, error: OFFLINE };
      const communityId = String(args.p_community_id);
      if (!me() || !permissionsIn(communityId).includes('community.view'))
        return { data: null, error: { code: '42501', message: 'not a member of this community' } };
      const current = notificationSettings.get(communityId) ?? {
        announcements: true,
        events: true,
        comments: true,
        alerts: true,
      };
      if (name === 'set_community_notification_settings') {
        for (const key of ['announcements', 'events', 'comments', 'alerts'] as const) {
          const value = args[`p_${key}`];
          if (typeof value === 'boolean') current[key] = value;
        }
        notificationSettings.set(communityId, current);
      }
      return { data: [{ ...current }], error: null };
    }
    if (name === 'list_community_members' || name === 'get_community_member') {
      if (offline) return { data: null, error: OFFLINE };
      const communityId = String(args.p_community_id);
      const perms = permissionsIn(communityId);
      if (!me() || !perms.includes('members.view'))
        return {
          data: null,
          error: { code: '42501', message: 'members.view is required in this community' },
        };
      const roles = perms.includes('roles.view');
      // Community-profile fields only: like the database, never the phone, e-mail or account status.
      const shape = (m: FakeMember) => {
        const name =
          m.display_name?.trim() || [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null;
        return {
          membership_id: m.membership_id,
          user_id: m.user_id,
          display_name: name,
          avatar_path: m.avatar_path,
          avatar_url: m.avatar_url,
          role_names: roles ? [...m.role_names].sort() : null,
          joined_at: m.joined_at,
          is_me: m.user_id === me(),
          first_name: m.first_name,
          last_name: m.last_name,
          bio: m.bio,
        };
      };
      const active = membersOf(communityId).filter(
        (m) => m.status === 'active' && m.profile_status === 'active',
      );
      if (name === 'get_community_member') {
        const m = active.find((x) => x.user_id === args.p_user_id);
        return { data: m ? [shape(m)] : [], error: null };
      }
      const query = (args.p_query as string | undefined)?.trim().toLowerCase();
      if (query && query.length > 100)
        return { data: null, error: { code: '22023', message: 'search text can be at most 100 characters' } };
      const rows = active
        .map(shape)
        .filter(
          (r) =>
            !query ||
            [r.display_name, r.first_name, r.last_name].some((v) => v?.toLowerCase().includes(query)),
        )
        .map(({ first_name: _f, last_name: _l, bio: _b, ...r }) => ({
          ...r,
          sort_unnamed: r.display_name === null,
          sort_name: (r.display_name ?? '').toLowerCase(),
        }))
        .sort(
          (a, b) =>
            Number(a.sort_unnamed) - Number(b.sort_unnamed) ||
            a.sort_name.localeCompare(b.sort_name) ||
            a.user_id.localeCompare(b.user_id),
        );
      const after = args.p_cursor_id ? rows.findIndex((r) => r.user_id === args.p_cursor_id) + 1 : 0;
      return { data: rows.slice(after, after + Number(args.p_limit ?? 30)), error: null };
    }
    if (name === 'create_document_upload') {
      if (offline) return { data: null, error: OFFLINE };
      const communityId = String(args.p_community_id);
      const perms = permissionsIn(communityId);
      if (!me() || !perms.includes('documents.upload'))
        return {
          data: null,
          error: { code: '42501', message: 'documents.upload is required in this community' },
        };
      const visibility = (args.p_visibility as string | undefined) ?? 'members';
      if (visibility === 'managers' && !perms.includes('documents.manage'))
        return {
          data: null,
          error: { code: '42501', message: 'restricted documents require documents.manage' },
        };
      const mime = String(args.p_mime_type ?? '')
        .trim()
        .toLowerCase();
      const ext = DOCUMENT_TYPES.find(([m]) => m === mime)?.[1];
      if (!ext) return { data: null, error: { code: '22023', message: `file type ${mime} is not allowed` } };
      const size = Number(args.p_file_size);
      if (!(size >= 1 && size <= documentMaxBytes))
        return {
          data: null,
          error: { code: '22023', message: `file size must be between 1 and ${documentMaxBytes} bytes` },
        };
      const folder = (args.p_folder_id as string | undefined) ?? null;
      if (folder && !allFolders().some((f) => f.id === folder && f.community_id === communityId))
        return { data: null, error: { code: '22023', message: 'folder not found in this community' } };
      documentCount += 1;
      const row = makeDocument(communityId, documentCount, {
        name: String(args.p_name).split(/[\\/]/).pop()!.trim(),
        mime_type: mime,
        file_extension: ext,
        file_size: size,
        folder_id: folder,
        visibility,
        status: 'pending_upload',
        uploaded_by: me(),
        uploaded_at: null,
        created_at: new Date().toISOString(),
      });
      row.storage_path = `communities/${communityId}/documents/${row.id}/file.${ext}`;
      content[communityId] = {
        ...content[communityId],
        documents: [...(content[communityId]?.documents ?? []), row],
      };
      return {
        data: [
          {
            document_id: row.id,
            bucket_id: 'documents',
            storage_path: row.storage_path,
            max_file_size_bytes: documentMaxBytes,
          },
        ],
        error: null,
      };
    }
    if (name === 'complete_document_upload') {
      if (offline) return { data: null, error: OFFLINE };
      const doc = allDocuments().find(
        (d) =>
          d.id === args.p_document_id &&
          d.status === 'pending_upload' &&
          d.uploaded_by === me() &&
          permissionsIn(d.community_id).includes('documents.upload'),
      );
      if (!doc) return { data: null, error: { code: 'P0002', message: 'no pending upload found' } };
      const stored = documentFiles.get(doc.storage_path);
      if (!stored) return { data: null, error: { code: 'P0002', message: 'the file has not been uploaded' } };
      if (stored.size < 1 || stored.size > documentMaxBytes)
        return {
          data: null,
          error: { code: '22023', message: 'stored file size is outside the allowed range' },
        };
      if (stored.mimetype.toLowerCase() !== doc.mime_type)
        return { data: null, error: { code: '22023', message: 'stored content type does not match' } };
      Object.assign(doc, { status: 'active', file_size: stored.size, uploaded_at: new Date().toISOString() });
      return { data: { ...doc }, error: null };
    }
    if (name === 'list_documents') {
      if (offline) return { data: null, error: OFFLINE };
      const statuses = (args.p_statuses as string[] | undefined) ?? ['active'];
      const folder = (args.p_folder_id as string | undefined) ?? null;
      const rows = allDocuments()
        .filter(
          (d) =>
            d.community_id === args.p_community_id &&
            statuses.includes(d.status) &&
            (folder === null || d.folder_id === folder) &&
            (!args.p_root_only || d.folder_id === null) &&
            canViewDocument(d),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const after = args.p_cursor_id ? rows.findIndex((row) => row.id === args.p_cursor_id) + 1 : 0;
      const limit = Math.min(Math.max(Number(args.p_limit ?? 25), 1), 100);
      return { data: rows.slice(after, after + limit).map((row) => ({ ...row })), error: null };
    }
    const CONTENT_RPCS: Record<string, keyof FakeContent> = {};
    if (
      [
        'list_my_notifications',
        'unread_notification_count',
        'mark_notification_read',
        'mark_notification_unread',
        'mark_all_notifications_read',
      ].includes(name)
    ) {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const community = (args.p_community_id as string | undefined) ?? null;
      const mine = notificationRows.filter(
        (row) => canReadNotification(row) && (community === null || row.community_id === community),
      );
      const now = new Date().toISOString();
      if (name === 'unread_notification_count')
        return { data: mine.filter((row) => !row.read_at && !row.archived_at).length, error: null };
      if (name === 'mark_all_notifications_read') {
        const unread = mine.filter((row) => !row.read_at && !row.archived_at);
        unread.forEach((row) => (row.read_at = now));
        return { data: unread.length, error: null };
      }
      if (name === 'mark_notification_read' || name === 'mark_notification_unread') {
        const row = mine.find((r) => r.id === args.p_notification_id);
        if (!row) return { data: false, error: null };
        const read = name === 'mark_notification_read';
        if (!!row.read_at === read) return { data: false, error: null };
        row.read_at = read ? now : null;
        return { data: true, error: null };
      }
      const rows = mine
        .filter(
          (row) =>
            (args.p_include_archived ? true : !row.archived_at) && (!args.p_unread_only || !row.read_at),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const cursor = args.p_cursor_created_at
        ? [String(args.p_cursor_created_at), String(args.p_cursor_id)]
        : null;
      const page = rows
        .filter(
          (row) =>
            !cursor || row.created_at < cursor[0]! || (row.created_at === cursor[0] && row.id < cursor[1]!),
        )
        .slice(0, Number(args.p_limit ?? 20));
      return { data: page.map((row) => ({ ...row })), error: null };
    }
    if (name === 'create_post') {
      // public.create_post(): post + pictures atomically; idempotent per (author, request id).
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      const communityId = String(args.p_community_id);
      const requestId = (args.p_client_request_id as string | undefined) ?? null;
      const images = (args.p_images as { path: string; width: number; height: number }[] | undefined) ?? [];
      if (requestId) {
        const existing = allPosts().find(
          (p) =>
            p.author_user_id === user &&
            (p as { client_request_id?: string }).client_request_id === requestId,
        );
        if (existing) return { data: [{ ...existing }], error: null };
      }
      if (images.length > 10)
        return { data: null, error: { code: '22023', message: 'a post can have at most 10 pictures' } };
      if (!permissionsIn(communityId).includes('posts.create'))
        return {
          data: null,
          error: { code: '42501', message: 'new row violates row-level security policy for table "posts"' },
        };
      const body = String(args.p_body ?? '');
      if (!body.trim()) return { data: null, error: { code: '23514', message: 'posts_body_check' } };
      for (const image of images) {
        const [folderCommunity, owner] = image.path.split('/');
        if (folderCommunity !== communityId || owner !== user)
          return {
            data: null,
            error: {
              code: '42501',
              message: 'a picture must be uploaded to your own folder of this community',
            },
          };
        if (!postImageFiles.has(image.path))
          return {
            data: null,
            error: { code: '22023', message: 'picture upload not found; upload the picture first' },
          };
      }
      const inserted = await runQuery('posts', 'insert', [], '*', { community_id: communityId, body }, true);
      if (inserted.error) return inserted;
      const post = allPosts().find((p) => p.id === (inserted.data as { id: string }).id)!;
      Object.assign(post, { client_request_id: requestId });
      const bucket = content[communityId]!;
      bucket.postImages = [
        ...(bucket.postImages ?? []),
        ...images.map((image, position) =>
          makePostImage(communityId, post.id, ++postImageCount, {
            storage_path: image.path,
            position,
            width: image.width,
            height: image.height,
            uploaded_by: user,
          }),
        ),
      ];
      return { data: [{ ...post }], error: null };
    }
    if (['list_upcoming_events', 'list_events', 'list_past_events'].includes(name)) {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const now = Date.now();
      const all = ((content[String(args.p_community_id)]?.events ?? []) as EventRow[]).filter(canViewEvent);
      const byStart = (a: EventRow, b: EventRow) =>
        a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id);
      let rows: EventRow[];
      if (name === 'list_upcoming_events') {
        rows = all.filter((e) => e.status === 'published' && Date.parse(e.ends_at) > now).sort(byStart);
      } else if (name === 'list_events') {
        const statuses = (args.p_statuses as string[] | undefined) ?? ['published', 'cancelled', 'completed'];
        const from = args.p_from ? Date.parse(String(args.p_from)) : null;
        const to = args.p_to ? Date.parse(String(args.p_to)) : null;
        rows = all
          .filter(
            (e) =>
              statuses.includes(e.status) &&
              (from === null || Date.parse(e.ends_at) >= from) &&
              (to === null || Date.parse(e.starts_at) < to),
          )
          .sort(byStart);
      } else {
        rows = all
          .filter(
            (e) =>
              e.status === 'completed' ||
              (['published', 'cancelled'].includes(e.status) && Date.parse(e.ends_at) <= now),
          )
          .sort((a, b) => byStart(b, a));
      }
      const after = args.p_cursor_id ? rows.findIndex((row) => row.id === args.p_cursor_id) + 1 : 0;
      return {
        data: rows.slice(after, after + Number(args.p_limit ?? 20)).map((row) => ({ ...row })),
        error: null,
      };
    }
    if (name === 'get_event_attendance') {
      if (offline) return { data: null, error: OFFLINE };
      if (!me()) return { data: null, error: AUTH_REQUIRED };
      const event = allEvents().find((e) => e.id === args.p_event_id);
      if (!event || !canViewEvent(event)) return { data: [], error: null };
      const rows = rsvpsOf(event);
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      const mine = rows.find((r) => r.user_id === me());
      const queue = rows
        .filter((r) => r.status === 'waitlisted')
        .sort(
          (a, b) =>
            String(a.waitlisted_at).localeCompare(String(b.waitlisted_at)) || a.id.localeCompare(b.id),
        );
      return {
        data: [
          {
            event_id: event.id,
            capacity: event.capacity,
            going_count: count('going'),
            maybe_count: count('maybe'),
            not_going_count: count('not_going'),
            waitlisted_count: count('waitlisted'),
            spots_left: event.capacity === null ? null : Math.max(event.capacity - count('going'), 0),
            my_status: mine?.status ?? null,
            my_waitlist_position: mine?.status === 'waitlisted' ? queue.indexOf(mine) + 1 : null,
          },
        ],
        error: null,
      };
    }
    if (name === 'rsvp_to_event' || name === 'cancel_rsvp') {
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      const event = allEvents().find((e) => e.id === args.p_event_id);
      if (name === 'cancel_rsvp') {
        // RLS: only while can_rsvp(); otherwise nothing is removed.
        if (!event || !canRsvp(event)) return { data: false, error: null };
        const bucket = content[event.community_id]!;
        const before = (bucket.rsvps ?? []) as RsvpRow[];
        const mine = before.find((r) => r.event_id === event.id && r.user_id === user);
        bucket.rsvps = before.filter((r) => r !== mine);
        if (mine?.status === 'going') promoteWaitlist(event);
        return { data: !!mine, error: null };
      }
      const status = String(args.p_status);
      if (!['going', 'maybe', 'not_going'].includes(status))
        return { data: null, error: { code: '22023', message: 'status must be going, maybe or not_going' } };
      if (!event || !canRsvp(event))
        return { data: null, error: { code: '42501', message: 'you cannot RSVP to this event' } };
      const bucket = content[event.community_id]!;
      bucket.rsvps = bucket.rsvps ?? [];
      let mine = (bucket.rsvps as RsvpRow[]).find((r) => r.event_id === event.id && r.user_id === user);
      if (!mine) {
        mine = makeRsvp(event.id, user, 'not_going');
        mine.status = '';
        bucket.rsvps.push(mine);
      }
      const wasGoing = mine.status === 'going';
      if (status === 'going') {
        const going = rsvpsOf(event).filter((r) => r.status === 'going' && r !== mine).length;
        if (wasGoing) {
          // unchanged
        } else if (event.capacity !== null && going >= event.capacity) {
          // Full: waitlisted; an existing place in the queue is kept.
          if (mine.status !== 'waitlisted')
            mine.waitlisted_at = new Date(Date.now() + ++rsvpClock).toISOString();
          mine.status = 'waitlisted';
        } else {
          mine.status = 'going';
          mine.waitlisted_at = null;
        }
      } else {
        mine.status = status;
        mine.waitlisted_at = null;
        if (wasGoing) promoteWaitlist(event);
      }
      return {
        data: [{ event_id: event.id, status: mine.status, waitlisted_at: mine.waitlisted_at }],
        error: null,
      };
    }
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
    if (name === 'create_invitation' || name === 'list_invitations' || name === 'revoke_invitation') {
      if (offline) return { data: null, error: OFFLINE };
      const user = me();
      if (!user) return { data: null, error: AUTH_REQUIRED };
      if (name === 'list_invitations') {
        // SECURITY INVOKER: RLS shows nothing without members.invite.
        const communityId = String(args.p_community_id);
        if (!permissionsIn(communityId).includes('members.invite')) return { data: [], error: null };
        const rows = createdInvitations
          .filter((i) => i.community_id === communityId)
          .map(({ token: _token, ...i }) => ({
            ...i,
            effective_status:
              i.status === 'active' && Date.parse(i.expires_at) <= Date.now() ? 'expired' : i.status,
          }))
          .filter((i) => args.p_include_inactive || i.effective_status === 'active')
          .reverse();
        return { data: rows, error: null };
      }
      if (name === 'revoke_invitation') {
        const inv = createdInvitations.find((i) => i.id === args.p_invitation_id);
        if (!inv || !permissionsIn(inv.community_id).includes('members.invite'))
          return { data: null, error: { code: 'P0002', message: 'invitation not found' } };
        if (inv.status === 'revoked') return { data: false, error: null };
        inv.status = 'revoked';
        const shared = invitations.get(inv.token);
        if (shared) shared.state = 'revoked';
        return { data: true, error: null };
      }
      const communityId = String(args.p_community_id);
      if (!permissionsIn(communityId).includes('members.invite'))
        return denied('members.invite is required in this community');
      const days = /^(\d+) days?$/.exec(String(args.p_expires_in ?? '7 days'));
      const hours = /^(\d+) hours?$/.exec(String(args.p_expires_in ?? ''));
      const ms = days ? Number(days[1]) * 86_400_000 : hours ? Number(hours[1]) * 3_600_000 : NaN;
      if (!(ms >= 3_600_000 && ms <= 30 * 86_400_000))
        return {
          data: null,
          error: { code: '22023', message: 'invitations must expire between 1 hour and 30 days from now' },
        };
      const maxUses = (args.p_max_uses as number | undefined) ?? null;
      if (maxUses !== null && (maxUses < 1 || maxUses > 10000))
        return { data: null, error: { code: '22023', message: 'max_uses must be between 1 and 10000' } };
      const n = 9000 + createdInvitations.length;
      const token = invitationToken(n);
      const row = {
        id: `abababab-0000-4000-8000-${String(n).padStart(12, '0')}`,
        community_id: communityId,
        created_by: user,
        expires_at: new Date(Date.now() + ms).toISOString(),
        max_uses: maxUses,
        use_count: 0,
        status: 'active',
        created_at: new Date().toISOString(),
        token,
      };
      createdInvitations.push(row);
      const community = communities.find(
        (c) => (c as { community_id: string }).community_id === communityId,
      ) as FakeInvitation['community'];
      invitations.set(token, { community, state: 'valid' });
      return {
        data: [{ invitation_id: row.id, token, expires_at: row.expires_at, max_uses: maxUses }],
        error: null,
      };
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
    /** The user's notifications on the "server" (change them to simulate new ones). */
    notifications: notificationRows,
    /** Notification preferences per community (as stored on the "server"). */
    notificationSettings,
    /** Pictures in the private stories bucket, and who saw which story. */
    storyFiles,
    storyViews,
    storiesStorage: storiesBucket,
    /** The marketplace catalog on the "server" (sellers, listings, stock, pictures, favorites). */
    market: market.state,
    /** Photos in the private alert-images bucket (path → uploader). */
    alertImageFiles,
    /** Files in the private documents bucket (path → stored size and type). */
    documentFiles,
    documentsStorage: documentsBucket,
    /** The app's document upload transport (pass to createDependencies). */
    uploadFile,
    /** The next n document transfers fail as if the network dropped. */
    failDocumentUploads: (n = 1) => {
      documentUploadFailures = n;
    },
    /** Document transfers stop half-way until released (or cancelled). */
    holdDocumentUploads: (hold = true) => {
      holdDocumentUploads = hold;
    },
    releaseDocumentUpload: () => {
      releaseHeld?.();
      releaseHeld = null;
    },
    /** The private post-images bucket (path → uploader). */
    postImagesStorage: postImagesBucket,
    postImageFiles,
    /** The next n picture uploads fail as if the network dropped. */
    failUploads: (n = 1) => {
      uploadFailures = n;
    },
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
    /** Invitations created through create_invitation (token included, for assertions only). */
    createdInvitations,
    /** Other members per community, as stored on the "server" (status and roles change). */
    memberRows,
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
  const photoQueue: (PickedImage[] | Error)[] = [];
  const fileQueue: (PickedFile | null | Error)[] = [];
  const cameraQueue: (PickedImage | null | Error)[] = [];
  const picker: MediaPicker = {
    takePhoto: jest.fn(async () => {
      const next = cameraQueue.length ? cameraQueue.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
    pickDocument: jest.fn(async () => {
      const next = fileQueue.length ? fileQueue.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
    pickImage: jest.fn(async (_kind: string) => {
      const next = queue.length ? queue.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
    pickPhotos: jest.fn(async (limit: number) => {
      const next = photoQueue.length ? photoQueue.shift()! : [];
      if (next instanceof Error) throw next;
      return next.slice(0, limit);
    }),
  };
  return {
    picker,
    next(image: PickedImage | null | Error) {
      queue.push(image);
    },
    /** The next "add photos" selection ([] = cancelled). */
    nextPhotos(photos: PickedImage[] | Error) {
      photoQueue.push(photos);
    },
    /** The next document picked (null = cancelled). */
    nextFile(file: PickedFile | null | Error) {
      fileQueue.push(file);
    },
    /** The next camera shot (null = cancelled, Error = permission refused). */
    nextShot(photo: PickedImage | null | Error) {
      cameraQueue.push(photo);
    },
  };
}

/** A scripted device position: each call to current() takes the next one (default: a fixed spot). */
export function fakeLocation() {
  const queue: (CurrentPosition | Error)[] = [];
  const source: LocationSource = {
    current: jest.fn(async () => {
      const next = queue.length ? queue.shift()! : { latitude: 51.501364, longitude: -0.14189, accuracy: 12 };
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return {
    source,
    next(position: CurrentPosition | Error) {
      queue.push(position);
    },
  };
}

/** A picked photo as the picker returns it (re-encoded JPEG). */
export const makePhoto = (n: number, width = 1080, height = 1350): PickedImage => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, n % 256, 0xff, 0xd9]),
  mimeType: 'image/jpeg',
  uri: `file:///photos/photo-${n}.jpg`,
  width,
  height,
});

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
  latitude: null as number | null,
  longitude: null as number | null,
  location_accuracy_m: null as number | null,
  image_path: null as string | null,
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

const fromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** An event starting n days from now (relative to the real clock: upcoming/past depend on it). */
export const makeEvent = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `c3c3c3c3-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  title: `Event ${n}`,
  description: null as string | null,
  location_text: `Hall ${n}` as string | null,
  starts_at: fromNow(60 * 24 * n),
  ends_at: fromNow(60 * 24 * n + 120),
  timezone: 'UTC',
  status: 'published',
  capacity: null as number | null,
  created_by: null as string | null,
  published_at: fromNow(-60) as string | null,
  cancelled_at: null as string | null,
  cancellation_reason: null as string | null,
  completed_at: null as string | null,
  edited_at: null as string | null,
  created_at: fromNow(-120),
  updated_at: fromNow(-120),
  ...overrides,
});

let rsvpIds = 0;
/** One person's RSVP to an event (waitlisted ones carry their queue time). */
export const makeRsvp = (
  eventId: string,
  userId: string,
  status: string,
  waitlistedAt: string | null = null,
) => ({
  id: `d4d4d4d4-0000-4000-8000-${String(++rsvpIds).padStart(12, '0')}`,
  event_id: eventId,
  user_id: userId,
  status,
  waitlisted_at:
    status === 'waitlisted' ? (waitlistedAt ?? new Date(Date.now() - 60_000 + rsvpIds).toISOString()) : null,
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

/** A notification for the signed-in user (TEST_USER_ID), newest = smallest n. */
export const makeNotification = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `a9a9a9a9-0000-4000-8000-${String(n).padStart(12, '0')}`,
  user_id: TEST_USER_ID,
  community_id: null as string | null,
  type: 'system',
  title: `Notification ${n}`,
  body: `Notification body ${n}`,
  data: {} as Record<string, unknown>,
  dedupe_key: null as string | null,
  read_at: null as string | null,
  archived_at: null as string | null,
  created_at: new Date(Date.now() - n * 60_000).toISOString(),
  ...overrides,
});

/** A co-member: profile, membership and a PRIVATE phone number (never returned to others). */
export const makeMember = (n: number, overrides: Record<string, unknown> = {}) => ({
  membership_id: `dddddddd-1111-4000-8000-${String(n).padStart(12, '0')}`,
  user_id: `bbbbbbbb-1111-4000-8000-${String(n).padStart(12, '0')}` as string,
  display_name: `Member ${n}` as string | null,
  first_name: null as string | null,
  last_name: null as string | null,
  bio: null as string | null,
  avatar_path: null as string | null,
  avatar_url: null as string | null,
  role_names: ['Member'] as string[],
  joined_at: '2025-06-01T12:00:00Z' as string | null,
  status: 'active',
  profile_status: 'active',
  phone: `+1 555 01${String(n).padStart(2, '0')}` as string | null,
  ...overrides,
});

/** An active story (as list_community_stories returns it), by another member unless overridden. */
export const makeStory = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => {
  const id = `e6e6e6e6-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const author = (overrides.author_user_id as string | undefined) ?? OTHER_USER_ID;
  return {
    id,
    community_id: communityId,
    author_user_id: author,
    author_display_name: 'Grace Hopper' as string | null,
    storage_path: `${communityId}/${author}/${id}.jpg`,
    caption: null as string | null,
    width: 1080,
    height: 1920,
    created_at: new Date(Date.now() - n * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000 - n * 60_000).toISOString(),
    viewed_by_me: false,
    view_count: null as number | null,
    deleted_at: null as string | null,
    client_request_id: null as string | null,
    ...overrides,
  };
};

/** A document folder. */
export const makeFolder = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `f7f7f7f7-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  parent_folder_id: null as string | null,
  name: `Folder ${n}`,
  created_by: OTHER_USER_ID as string | null,
  created_at: new Date(Date.now() - 86_400_000).toISOString(),
  updated_at: new Date(Date.now() - 86_400_000).toISOString(),
  ...overrides,
});

/** A file as the document picker returns it. */
export const pickedFile = (
  name = 'Minutes.pdf',
  size = 120_000,
  mimeType: string | null = 'application/pdf',
): PickedFile => ({
  name,
  mimeType,
  size,
  uri: `file:///cache/${name}`,
  read: jest.fn(async () => new Uint8Array(size)),
});

/** An active document in a community. */
export const makeDocument = (communityId: string, n: number, overrides: Record<string, unknown> = {}) => ({
  id: `b8b8b8b8-0000-4000-8000-${String(n).padStart(12, '0')}`,
  community_id: communityId,
  folder_id: null as string | null,
  name: `Document ${n}.pdf`,
  file_extension: 'pdf',
  mime_type: 'application/pdf',
  file_size: 120_000,
  visibility: 'members',
  status: 'active',
  storage_path: `communities/${communityId}/documents/b8b8b8b8-0000-4000-8000-${String(n).padStart(12, '0')}/file.pdf`,
  uploaded_by: OTHER_USER_ID as string | null,
  uploaded_at: new Date(Date.now() - 86_400_000).toISOString() as string | null,
  created_at: new Date(Date.now() - 86_400_000).toISOString(),
  updated_at: new Date(Date.now() - 86_400_000).toISOString(),
  archived_at: null as string | null,
  deleted_at: null as string | null,
  file_purged_at: null as string | null,
  updated_by_user_id: null as string | null,
  ...overrides,
});

/** A post picture; its file is seeded into the post-images bucket. */
export const makePostImage = (
  communityId: string,
  postId: string,
  n: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `e7e7e7e7-0000-4000-8000-${String(n).padStart(12, '0')}`,
  post_id: postId,
  community_id: communityId,
  storage_path: `${communityId}/${OTHER_USER_ID}/e7e7e7e7-0000-4000-8000-${String(n).padStart(12, '0')}.jpg`,
  position: 0,
  width: 1080,
  height: 1350,
  uploaded_by: OTHER_USER_ID as string | null,
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

/** A payment page that "returns" (or is closed) without a device browser. */
export function fakePaymentBrowser() {
  const outcomes: ('returned' | 'closed')[] = [];
  const browser: PaymentBrowser = {
    open: jest.fn(async () => (outcomes.length ? outcomes.shift()! : 'returned')),
  };
  return {
    browser,
    next(outcome: 'returned' | 'closed') {
      outcomes.push(outcome);
    },
  };
}

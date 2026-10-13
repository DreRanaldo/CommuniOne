// Membership management: list members, approve, reject, suspend, reinstate,
// remove, leave. Who may do what is decided by the database (RLS +
// private.enforce_membership_update): approvals need members.approve,
// suspensions members.suspend, removals members.remove, and the actor must
// "cover" every permission the target holds. Memberships are never inserted
// by clients; people join by creating a community or redeeming an invitation.

import { ErrorCode, ServiceError } from '../core/errors.ts';
import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import { AVATAR_BUCKET } from '../auth/index.ts';

export const MEMBERSHIP_STATUSES = ['pending', 'active', 'suspended', 'rejected', 'left'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export interface Member {
  id: string;
  userId: string;
  status: MembershipStatus;
  joinedAt: string | null;
  createdAt: string;
  displayName: string | null;
  avatarUrl: string | null;
  roles: { id: string; name: string }[];
}

/**
 * A directory entry (RN-14): community-profile fields only. The database
 * returns nothing else (no phone, e-mail or account status), so the app
 * cannot receive what it must not show.
 */
export interface DirectoryMember {
  membershipId: string;
  userId: string;
  displayName: string | null;
  /** Short-lived signed URL (uploaded avatar) or external URL, or null. */
  avatarUrl: string | null;
  /** Role names; null when the caller may not see roles (no roles.view). */
  roles: string[] | null;
  joinedAt: string | null;
  isMe: boolean;
}

/** A member's community profile (RN-14). */
export interface MemberProfile extends DirectoryMember {
  firstName: string | null;
  lastName: string | null;
  bio: string | null;
}

export const MEMBER_SEARCH_MAX = 100;

const MEMBER_COLUMNS = 'id, user_id, status, joined_at, created_at, profiles(display_name, avatar_url), membership_roles(roles(id, name))';

interface MemberRow {
  id: string;
  user_id: string;
  status: string;
  joined_at: string | null;
  created_at: string;
  profiles: { display_name: string | null; avatar_url: string | null } | null;
  membership_roles: { roles: { id: string; name: string } | null }[];
}

const toMember = (row: MemberRow): Member => ({
  id: row.id,
  userId: row.user_id,
  status: row.status as MembershipStatus,
  joinedAt: row.joined_at,
  createdAt: row.created_at,
  displayName: row.profiles?.display_name ?? null,
  avatarUrl: row.profiles?.avatar_url ?? null,
  roles: row.membership_roles.flatMap((mr) => (mr.roles ? [mr.roles] : [])),
});

export function membershipsService(ctx: ServiceContext) {
  const { db } = ctx;

  const setStatus = (operation: string, membershipId: string, status: MembershipStatus) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const id = v.uuid(membershipId, 'membershipId');
      const updated = await mutateOne(
        () => db.from('memberships').update({ status }).eq('id', id).select(MEMBER_COLUMNS),
        () => db.from('memberships').select('id').eq('id', id),
        'Membership not found.',
      );
      // Role changes made by the status trigger (e.g. the default role on
      // approval) are not visible in the UPDATE's own result; re-read.
      const fresh = unwrap(await db.from('memberships').select(MEMBER_COLUMNS).eq('id', id).maybeSingle());
      return toMember((fresh ?? updated) as unknown as MemberRow);
    });

  /** Signed avatar URLs (avatars bucket: readable where the profile is). */
  const avatars = async (rows: { avatar_path: string | null; avatar_url: string | null }[], seconds = 3600) => {
    const paths = [...new Set(rows.map((r) => r.avatar_path).filter((p): p is string => !!p))];
    const urls = new Map<string, string>();
    if (paths.length > 0) {
      const signed = await db.storage.from(AVATAR_BUCKET).createSignedUrls(paths, seconds);
      for (const item of signed.data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
    }
    return (row: { avatar_path: string | null; avatar_url: string | null }) =>
      (row.avatar_path ? urls.get(row.avatar_path) : row.avatar_url) ?? null;
  };

  return {
    /**
     * The member directory of one community (RN-14): active members by name,
     * optionally searched by name. Requires members.view there; roles only
     * with roles.view. Community-profile fields only (see DirectoryMember).
     */
    directory(input: { communityId: string; query?: string } & PageRequest): Promise<Page<DirectoryMember>> {
      return ctx.run('memberships.directory', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'query', 'limit', 'cursor']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const query = input.query === undefined || input.query.trim() === ''
          ? undefined
          : v.text(input.query, 'query', { max: MEMBER_SEARCH_MAX });
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['int', 'arg', 'uuid']);
        const rows = unwrap(await db.rpc('list_community_members', {
          p_community_id: communityId,
          p_query: query,
          p_limit: limit,
          p_cursor_unnamed: c ? c[0] === 1 : undefined,
          p_cursor_name: (c?.[1] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[2] as string | undefined) ?? undefined,
        })) ?? [];
        const avatarOf = await avatars(rows);
        const page = toPage(rows, limit, (last) => [last.sort_unnamed ? 1 : 0, last.sort_name, last.user_id]);
        return {
          ...page,
          items: page.items.map((r) => ({
            membershipId: r.membership_id,
            userId: r.user_id,
            displayName: r.display_name,
            avatarUrl: avatarOf(r),
            roles: r.role_names,
            joinedAt: r.joined_at,
            isMe: r.is_me,
          })),
        };
      });
    },

    /** One active member's community profile (RN-14). NOT_FOUND unless they are an active member of this community. */
    member(communityId: string, userId: string): Promise<MemberProfile> {
      return ctx.run('memberships.member', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.rpc('get_community_member', {
          p_community_id: v.uuid(communityId, 'communityId'),
          p_user_id: v.uuid(userId, 'userId'),
        })) ?? [];
        const r = rows[0];
        if (!r) throw new ServiceError(ErrorCode.NotFound, 'Member not found.');
        const avatarOf = await avatars([r]);
        return {
          membershipId: r.membership_id,
          userId: r.user_id,
          displayName: r.display_name,
          avatarUrl: avatarOf(r),
          roles: r.role_names,
          joinedAt: r.joined_at,
          isMe: r.is_me,
          firstName: r.first_name,
          lastName: r.last_name,
          bio: r.bio,
        };
      });
    },

    /**
     * Members of a community, oldest first. Active members need members.view;
     * other statuses need members.approve / suspend / remove (RLS).
     */
    list(input: { communityId: string; status?: MembershipStatus } & PageRequest): Promise<Page<Member>> {
      return ctx.run('memberships.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'status', 'limit', 'cursor']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const status = input.status === undefined ? 'active' : v.oneOf(input.status, 'status', MEMBERSHIP_STATUSES);
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        let query = db.from('memberships').select(MEMBER_COLUMNS)
          .eq('community_id', communityId).eq('status', status)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .limit(limit);
        if (cursor) {
          // Values are type-checked by decodeCursor (ISO timestamp, uuid), so
          // they cannot alter the filter expression.
          const [at, id] = cursor as [string, string];
          query = query.or(`created_at.gt.${at},and(created_at.eq.${at},id.gt.${id})`);
        }
        const rows = unwrap(await query) as unknown as MemberRow[];
        return toPage(rows.map(toMember), limit, (last) => [last.createdAt, last.id]);
      });
    },

    /** The caller's own membership in a community, or null. */
    getMine(communityId: string): Promise<{ id: string; status: MembershipStatus } | null> {
      return ctx.run('memberships.getMine', async () => {
        const userId = await ctx.requireUserId();
        const row = unwrap(await db.from('memberships').select('id, status')
          .eq('community_id', v.uuid(communityId, 'communityId')).eq('user_id', userId).maybeSingle());
        return row ? { id: row.id, status: row.status as MembershipStatus } : null;
      });
    },

    /** pending / rejected / left → active. Requires members.approve. Assigns the default role. */
    approve: (membershipId: string) => setStatus('memberships.approve', membershipId, 'active'),
    /** pending → rejected. Requires members.approve. */
    reject: (membershipId: string) => setStatus('memberships.reject', membershipId, 'rejected'),
    /** active → suspended. Requires members.suspend. Access ends immediately. */
    suspend: (membershipId: string) => setStatus('memberships.suspend', membershipId, 'suspended'),
    /** suspended → active. Requires members.suspend. */
    reinstate: (membershipId: string) => setStatus('memberships.reinstate', membershipId, 'active'),

    /** Removes someone else's membership. Requires members.remove; never yourself (use leave). */
    remove(membershipId: string): Promise<void> {
      return ctx.run('memberships.remove', async () => {
        await ctx.requireUserId();
        const id = v.uuid(membershipId, 'membershipId');
        await mutateOne(
          () => db.from('memberships').delete().eq('id', id).select('id'),
          () => db.from('memberships').select('id').eq('id', id),
          'Membership not found.',
        );
      });
    },

    /** The caller leaves a community. Refused for its last role manager. */
    leave(communityId: string): Promise<void> {
      return ctx.run('memberships.leave', async () => {
        const userId = await ctx.requireUserId();
        const mine = unwrapOne(await db.from('memberships').select('id')
          .eq('community_id', v.uuid(communityId, 'communityId')).eq('user_id', userId).maybeSingle(), 'You are not a member of this community.');
        const rows = unwrap(await db.from('memberships').update({ status: 'left' }).eq('id', mine.id).select('id'));
        if (!rows?.length) throw new ServiceError(ErrorCode.Conflict, 'You cannot leave this community right now.');
      });
    },
  };
}

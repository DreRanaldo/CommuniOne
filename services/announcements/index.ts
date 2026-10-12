// Announcements: draft, publish, edit, archive, delete, read.
// announcements.create lets members manage their own; announcements.manage any.
// Lifecycle rules are enforced by the database trigger.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export type Announcement = Tables<'announcements'>;
type Fns = Database['public']['Functions'];
export type CurrentAnnouncement = Fns['list_current_announcements']['Returns'][number];
export type AnnouncementHistoryItem = Fns['list_announcement_history']['Returns'][number];

export const ANNOUNCEMENT_PRIORITIES = ['normal', 'important'] as const;
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived', 'deleted'] as const;

export interface AnnouncementInput {
  communityId: string;
  title: string;
  body: string;
  priority?: (typeof ANNOUNCEMENT_PRIORITIES)[number];
  expiresAt?: string | Date | null;
  /** Publish immediately instead of saving a draft. */
  publish?: boolean;
}

export interface AnnouncementPatch {
  title?: string;
  body?: string;
  priority?: (typeof ANNOUNCEMENT_PRIORITIES)[number];
  expiresAt?: string | Date | null;
}

const title = (value: unknown) => v.text(value, 'title', { max: 200 });
const body = (value: unknown) => v.text(value, 'body', { max: 20_000 });

export function announcementsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, id: string, patch: () => Database['public']['Tables']['announcements']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const announcementId = v.uuid(id, 'announcementId');
      return mutateOne(
        () => db.from('announcements').update(values).eq('id', announcementId).select('*'),
        () => db.from('announcements').select('id').eq('id', announcementId),
        'Announcement not found.',
      );
    });

  return {
    /** Requires announcements.create. Saved as a draft unless publish is true. */
    create(input: AnnouncementInput): Promise<Announcement> {
      return ctx.run('announcements.create', async () => {
        await ctx.requireUserId();
        v.only<AnnouncementInput>(input, 'input', ['communityId', 'title', 'body', 'priority', 'expiresAt', 'publish']);
        return unwrapOne(await db.from('announcements').insert({
          community_id: v.uuid(input.communityId, 'communityId'),
          title: title(input.title),
          body: body(input.body),
          priority: input.priority === undefined ? 'normal' : v.oneOf(input.priority, 'priority', ANNOUNCEMENT_PRIORITIES),
          expires_at: v.optionalDateTime(input.expiresAt, 'expiresAt') ?? null,
          status: input.publish === undefined || !v.bool(input.publish, 'publish') ? 'draft' : 'published',
        }).select('*').maybeSingle());
      });
    },

    get(announcementId: string): Promise<Announcement> {
      return ctx.run('announcements.get', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('announcements').select('*')
          .eq('id', v.uuid(announcementId, 'announcementId')).maybeSingle(), 'Announcement not found.');
      });
    },

    /** Editable only while draft or published; published edits are marked as edited. */
    edit: (announcementId: string, patch: AnnouncementPatch) => update('announcements.edit', announcementId, () => {
      v.only<AnnouncementPatch>(patch, 'patch', ['title', 'body', 'priority', 'expiresAt']);
      return v.nonEmptyPatch({
        title: patch.title === undefined ? undefined : title(patch.title),
        body: patch.body === undefined ? undefined : body(patch.body),
        priority: patch.priority === undefined ? undefined : v.oneOf(patch.priority, 'priority', ANNOUNCEMENT_PRIORITIES),
        expires_at: v.optionalDateTime(patch.expiresAt, 'expiresAt'),
      }, 'patch');
    }),
    /** draft or archived → published. Notifies members. */
    publish: (announcementId: string) => update('announcements.publish', announcementId, () => ({ status: 'published' })),
    archive: (announcementId: string) => update('announcements.archive', announcementId, () => ({ status: 'archived' })),
    /** Soft delete; terminal. */
    delete: (announcementId: string) => update('announcements.delete', announcementId, () => ({ status: 'deleted' })),

    /** Published and not expired; important first, then newest. */
    listCurrent(input: { communityId: string } & PageRequest): Promise<Page<CurrentAnnouncement>> {
      return ctx.run('announcements.listCurrent', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['text', 'timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_current_announcements', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_priority: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_published_at: (c?.[1] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[2] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.priority, last.published_at, last.id]);
      });
    },

    /** Published (including expired) and archived; managers may also ask for drafts or deleted ones. */
    listHistory(input: { communityId: string; statuses?: (typeof ANNOUNCEMENT_STATUSES)[number][] } & PageRequest): Promise<Page<AnnouncementHistoryItem>> {
      return ctx.run('announcements.listHistory', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'statuses', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_announcement_history', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_sort_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
          p_statuses: input.statuses === undefined ? undefined : v.enumList(input.statuses, 'statuses', ANNOUNCEMENT_STATUSES),
        }));
        return toPage(rows, limit, (last) => [last.sort_at, last.id]);
      });
    },
  };
}

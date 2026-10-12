// In-app notifications: the caller's own inbox only. Notifications are
// created by the database (producers) and trusted backend code, never by
// clients.

import { unwrap, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Tables } from '../database.types.ts';

export type Notification = Tables<'notifications'>;

export function notificationsService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Newest first. */
    list(input: { unreadOnly?: boolean; communityId?: string; includeArchived?: boolean } & PageRequest = {}): Promise<Page<Notification>> {
      return ctx.run('notifications.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['unreadOnly', 'communityId', 'includeArchived', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_my_notifications', {
          p_limit: limit,
          p_cursor_created_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
          p_unread_only: input.unreadOnly === undefined ? false : v.bool(input.unreadOnly, 'unreadOnly'),
          p_community_id: v.optionalUuid(input.communityId, 'communityId') ?? undefined,
          p_include_archived: input.includeArchived === undefined ? false : v.bool(input.includeArchived, 'includeArchived'),
        }));
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },

    unreadCount(communityId?: string): Promise<number> {
      return ctx.run('notifications.unreadCount', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('unread_notification_count', {
          p_community_id: v.optionalUuid(communityId, 'communityId') ?? undefined,
        })) as number;
      });
    },

    /** Returns whether anything changed (false for someone else's notification: it is invisible). */
    markRead(notificationId: string): Promise<boolean> {
      return ctx.run('notifications.markRead', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('mark_notification_read', { p_notification_id: v.uuid(notificationId, 'notificationId') })) as boolean;
      });
    },

    markUnread(notificationId: string): Promise<boolean> {
      return ctx.run('notifications.markUnread', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('mark_notification_unread', { p_notification_id: v.uuid(notificationId, 'notificationId') })) as boolean;
      });
    },

    markAllRead(communityId?: string): Promise<number> {
      return ctx.run('notifications.markAllRead', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('mark_all_notifications_read', {
          p_community_id: v.optionalUuid(communityId, 'communityId') ?? undefined,
        })) as number;
      });
    },

    archive(notificationId: string): Promise<boolean> {
      return ctx.run('notifications.archive', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('archive_notification', { p_notification_id: v.uuid(notificationId, 'notificationId') })) as boolean;
      });
    },

    delete(notificationId: string): Promise<boolean> {
      return ctx.run('notifications.delete', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.from('notifications').delete().eq('id', v.uuid(notificationId, 'notificationId')).select('id'));
        return (rows?.length ?? 0) > 0;
      });
    },
  };
}

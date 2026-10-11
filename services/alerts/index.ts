// Alerts: create (draft or published), publish, edit, cancel, expire,
// archive, read. Emergency severity needs alerts.manage. Alerts are safety
// records and are never deleted.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export type Alert = Tables<'alerts'>;
type Fns = Database['public']['Functions'];
export type ActiveAlert = Fns['list_active_alerts']['Returns'][number];
export type AlertHistoryItem = Fns['list_alert_history']['Returns'][number];

export const ALERT_SEVERITIES = ['info', 'warning', 'urgent', 'emergency'] as const;
export const ALERT_STATUSES = ['draft', 'published', 'expired', 'cancelled', 'archived'] as const;

export interface AlertInput {
  communityId: string;
  title: string;
  body: string;
  severity?: (typeof ALERT_SEVERITIES)[number];
  expiresAt?: string | Date | null;
  publish?: boolean;
}

export interface AlertPatch {
  title?: string;
  body?: string;
  severity?: (typeof ALERT_SEVERITIES)[number];
  expiresAt?: string | Date | null;
}

const title = (value: unknown) => v.text(value, 'title', { max: 160 });
const body = (value: unknown) => v.text(value, 'body', { max: 5_000 });

export function alertsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, id: string, patch: () => Database['public']['Tables']['alerts']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const alertId = v.uuid(id, 'alertId');
      return mutateOne(
        () => db.from('alerts').update(values).eq('id', alertId).select('*'),
        () => db.from('alerts').select('id').eq('id', alertId),
        'Alert not found.',
      );
    });

  return {
    /** Requires alerts.create (emergency: alerts.manage). Draft unless publish is true. */
    create(input: AlertInput): Promise<Alert> {
      return ctx.run('alerts.create', async () => {
        await ctx.requireUserId();
        v.only<AlertInput>(input, 'input', ['communityId', 'title', 'body', 'severity', 'expiresAt', 'publish']);
        return unwrapOne(await db.from('alerts').insert({
          community_id: v.uuid(input.communityId, 'communityId'),
          title: title(input.title),
          body: body(input.body),
          severity: input.severity === undefined ? 'info' : v.oneOf(input.severity, 'severity', ALERT_SEVERITIES),
          expires_at: v.optionalDateTime(input.expiresAt, 'expiresAt') ?? null,
          status: input.publish === undefined || !v.bool(input.publish, 'publish') ? 'draft' : 'published',
        }).select('*').maybeSingle());
      });
    },

    get(alertId: string): Promise<Alert> {
      return ctx.run('alerts.get', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('alerts').select('*').eq('id', v.uuid(alertId, 'alertId')).maybeSingle(), 'Alert not found.');
      });
    },

    edit: (alertId: string, patch: AlertPatch) => update('alerts.edit', alertId, () => {
      v.only<AlertPatch>(patch, 'patch', ['title', 'body', 'severity', 'expiresAt']);
      return v.nonEmptyPatch({
        title: patch.title === undefined ? undefined : title(patch.title),
        body: patch.body === undefined ? undefined : body(patch.body),
        severity: patch.severity === undefined ? undefined : v.oneOf(patch.severity, 'severity', ALERT_SEVERITIES),
        expires_at: v.optionalDateTime(patch.expiresAt, 'expiresAt'),
      }, 'patch');
    }),
    /** draft → published. Notifies members and emits an outbox event. */
    publish: (alertId: string) => update('alerts.publish', alertId, () => ({ status: 'published' })),
    /** Retracts a published alert or discards a draft. */
    cancel: (alertId: string, reason?: string) => update('alerts.cancel', alertId, () => ({
      status: 'cancelled', cancellation_reason: v.optionalText(reason, 'reason', { max: 500 }) ?? null,
    })),
    expire: (alertId: string) => update('alerts.expire', alertId, () => ({ status: 'expired' })),
    archive: (alertId: string) => update('alerts.archive', alertId, () => ({ status: 'archived' })),

    /** Active alerts in a community: emergencies first, then newest. */
    listActive(input: { communityId: string } & PageRequest): Promise<Page<ActiveAlert>> {
      return ctx.run('alerts.listActive', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['int', 'timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_active_alerts', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_severity_rank: (c?.[0] as number | undefined) ?? undefined,
          p_cursor_published_at: (c?.[1] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[2] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.severity_rank, last.published_at, last.id]);
      });
    },

    /** Active alerts across all of the caller's communities (banner); at most 50. */
    listMyActive() {
      return ctx.run('alerts.listMyActive', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('list_my_active_alerts')) ?? [];
      });
    },

    listHistory(input: { communityId: string; statuses?: (typeof ALERT_STATUSES)[number][] } & PageRequest): Promise<Page<AlertHistoryItem>> {
      return ctx.run('alerts.listHistory', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'statuses', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_alert_history', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_sort_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
          p_statuses: input.statuses === undefined ? undefined : v.enumList(input.statuses, 'statuses', ALERT_STATUSES),
        }));
        return toPage(rows, limit, (last) => [last.sort_at, last.id]);
      });
    },
  };
}

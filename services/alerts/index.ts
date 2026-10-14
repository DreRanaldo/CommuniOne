// Alerts: create (draft or published), publish, edit, cancel, expire,
// archive, read. Emergency severity needs alerts.manage. Alerts are safety
// records and are never deleted. Since migration 31 an alert may carry the
// sender's position (only when they choose to share it) and one photo in the
// private alert-images bucket; both are set only when the alert is created.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, serverOutdated, ServiceError } from '../core/errors.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export type Alert = Tables<'alerts'>;
type Fns = Database['public']['Functions'];
export type ActiveAlert = Fns['list_active_alerts']['Returns'][number];
export type AlertHistoryItem = Fns['list_alert_history']['Returns'][number];

export const ALERT_SEVERITIES = ['info', 'warning', 'urgent', 'emergency'] as const;
export const ALERT_STATUSES = ['draft', 'published', 'expired', 'cancelled', 'archived'] as const;

export const ALERT_IMAGES_BUCKET = 'alert-images';
export const ALERT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Where the sender was (WGS84 degrees); accuracy in metres. */
export interface AlertLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export interface AlertInput {
  communityId: string;
  title: string;
  body: string;
  severity?: (typeof ALERT_SEVERITIES)[number];
  expiresAt?: string | Date | null;
  publish?: boolean;
  /** Shared only when the sender chose to; stored rounded to about 1 m. */
  location?: AlertLocation | null;
  /** One photo (JPEG, PNG or WebP, at most 10 MB). */
  image?: { file: UploadBody; mimeType: ImageMimeType } | null;
}

export interface AlertPatch {
  title?: string;
  body?: string;
  severity?: (typeof ALERT_SEVERITIES)[number];
  expiresAt?: string | Date | null;
}

const title = (value: unknown) => v.text(value, 'title', { max: 160 });
const body = (value: unknown) => v.text(value, 'body', { max: 5_000 });

const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

const coordinate = (value: unknown, field: string, limit: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit)
    v.fail(field, `${field} must be a number between -${limit} and ${limit}.`);
  return Math.round((value as number) * 1e5) / 1e5;
};

function location(input: unknown): { latitude: number; longitude: number; location_accuracy_m: number | null } | null {
  if (input === undefined || input === null) return null;
  v.only<AlertLocation>(input as AlertLocation, 'location', ['latitude', 'longitude', 'accuracy']);
  const loc = input as AlertLocation;
  const accuracy = loc.accuracy;
  if (accuracy !== undefined && accuracy !== null && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0))
    v.fail('accuracy', 'accuracy must be a positive number of metres.');
  return {
    latitude: coordinate(loc.latitude, 'latitude', 90),
    longitude: coordinate(loc.longitude, 'longitude', 180),
    location_accuracy_m: accuracy === undefined || accuracy === null ? null : Math.min(100_000, Math.round(accuracy)),
  };
}

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
    /**
     * Requires alerts.create (emergency: alerts.manage). Draft unless publish
     * is true. The photo, if any, is uploaded first to the caller's own folder
     * and removed again if the alert cannot be created.
     */
    create(input: AlertInput): Promise<Alert> {
      return ctx.run('alerts.create', async () => {
        const userId = await ctx.requireUserId();
        v.only<AlertInput>(input, 'input', ['communityId', 'title', 'body', 'severity', 'expiresAt', 'publish', 'location', 'image']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const values = {
          community_id: communityId,
          title: title(input.title),
          body: body(input.body),
          severity: input.severity === undefined ? 'info' : v.oneOf(input.severity, 'severity', ALERT_SEVERITIES),
          expires_at: v.optionalDateTime(input.expiresAt, 'expiresAt') ?? null,
          status: input.publish === undefined || !v.bool(input.publish, 'publish') ? 'draft' : 'published',
          ...location(input.location),
        };
        let imagePath: string | null = null;
        if (input.image !== undefined && input.image !== null) {
          const { mimeType, ext } = checkImage(input.image, ALERT_IMAGE_MAX_BYTES);
          imagePath = `${communityId}/${userId}/${randomId()}.${ext}`;
          const stored = await db.storage.from(ALERT_IMAGES_BUCKET)
            .upload(imagePath, uploadBody(input.image.file, mimeType), { contentType: mimeType, upsert: false });
          if (stored.error) {
            const status = Number((stored.error as { statusCode?: string | number }).statusCode ?? 0);
            if (status === 403 || /row-level security|unauthorized/i.test(stored.error.message))
              throw new ServiceError(ErrorCode.Forbidden, "You can't send alerts in this community.", {}, stored.error);
            if (/bucket not found/i.test(stored.error.message)) throw serverOutdated(stored.error);
            throw new ServiceError(ErrorCode.ServerError, 'The photo could not be uploaded. Try again.', {}, stored.error);
          }
        }
        try {
          return unwrapOne(await db.from('alerts').insert({ ...values, image_path: imagePath }).select('*').maybeSingle());
        } catch (error) {
          // Best effort: an unused photo is also purged by list_alert_image_files_to_purge.
          if (imagePath) await db.storage.from(ALERT_IMAGES_BUCKET).remove([imagePath]).catch(() => undefined);
          throw error;
        }
      });
    },

    /** A short-lived link to an alert's photo (null without one, or when it cannot be read). */
    imageUrl(alert: { image_path: string | null }, seconds = 3600): Promise<string | null> {
      return ctx.run('alerts.imageUrl', async () => {
        await ctx.requireUserId();
        const path = alert.image_path;
        if (!path || !IMAGE_PATH.test(path)) return null;
        const signed = await db.storage.from(ALERT_IMAGES_BUCKET).createSignedUrl(path, seconds);
        return signed.data?.signedUrl ?? null;
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

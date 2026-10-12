// Events and RSVPs: create, publish, edit, cancel, complete, RSVP and
// attendance. Capacity and the FIFO waitlist are enforced atomically in the
// database (rsvp_to_event takes the event row lock).

import { mutateOne, unwrap, unwrapOne, firstRow, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export type CommunityEvent = Tables<'events'>;
export type Attendance = Database['public']['Functions']['get_event_attendance']['Returns'][number];

export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;
export const RSVP_STATUSES = ['going', 'maybe', 'not_going'] as const;

export interface EventInput {
  communityId: string;
  title: string;
  startsAt: string | Date;
  endsAt: string | Date;
  description?: string | null;
  locationText?: string | null;
  timezone?: string;
  capacity?: number | null;
  publish?: boolean;
}

export interface EventPatch {
  title?: string;
  startsAt?: string | Date;
  endsAt?: string | Date;
  description?: string | null;
  locationText?: string | null;
  timezone?: string;
  capacity?: number | null;
}

const title = (value: unknown) => v.text(value, 'title', { max: 200 });
const timezone = (value: unknown) => v.text(value, 'timezone', { max: 64, pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/ });
const capacity = (value: unknown) => (value === null ? null : v.int(value, 'capacity', 1, 100_000));

function checkTimes(startsAt: string | undefined, endsAt: string | undefined) {
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) v.fail('endsAt', 'endsAt must not be before startsAt.');
}

export function eventsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, id: string, patch: () => Database['public']['Tables']['events']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const eventId = v.uuid(id, 'eventId');
      return mutateOne(
        () => db.from('events').update(values).eq('id', eventId).select('*'),
        () => db.from('events').select('id').eq('id', eventId),
        'Event not found.',
      );
    });

  return {
    /** Requires events.create. Draft unless publish is true. */
    create(input: EventInput): Promise<CommunityEvent> {
      return ctx.run('events.create', async () => {
        await ctx.requireUserId();
        v.only<EventInput>(input, 'input', ['communityId', 'title', 'startsAt', 'endsAt', 'description', 'locationText', 'timezone', 'capacity', 'publish']);
        const startsAt = v.dateTime(input.startsAt, 'startsAt');
        const endsAt = v.dateTime(input.endsAt, 'endsAt');
        checkTimes(startsAt, endsAt);
        return unwrapOne(await db.from('events').insert({
          community_id: v.uuid(input.communityId, 'communityId'),
          title: title(input.title),
          starts_at: startsAt,
          ends_at: endsAt,
          description: v.optionalText(input.description, 'description', { max: 10_000 }) ?? null,
          location_text: v.optionalText(input.locationText, 'locationText', { max: 500 }) ?? null,
          timezone: input.timezone === undefined ? undefined : timezone(input.timezone),
          capacity: input.capacity === undefined ? null : capacity(input.capacity),
          status: input.publish === undefined || !v.bool(input.publish, 'publish') ? 'draft' : 'published',
        }).select('*').maybeSingle());
      });
    },

    get(eventId: string): Promise<CommunityEvent> {
      return ctx.run('events.get', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('events').select('*').eq('id', v.uuid(eventId, 'eventId')).maybeSingle(), 'Event not found.');
      });
    },

    edit: (eventId: string, patch: EventPatch) => update('events.edit', eventId, () => {
      v.only<EventPatch>(patch, 'patch', ['title', 'startsAt', 'endsAt', 'description', 'locationText', 'timezone', 'capacity']);
      const startsAt = patch.startsAt === undefined ? undefined : v.dateTime(patch.startsAt, 'startsAt');
      const endsAt = patch.endsAt === undefined ? undefined : v.dateTime(patch.endsAt, 'endsAt');
      checkTimes(startsAt, endsAt);
      return v.nonEmptyPatch({
        title: patch.title === undefined ? undefined : title(patch.title),
        starts_at: startsAt,
        ends_at: endsAt,
        description: v.optionalText(patch.description, 'description', { max: 10_000 }),
        location_text: v.optionalText(patch.locationText, 'locationText', { max: 500 }),
        timezone: patch.timezone === undefined ? undefined : timezone(patch.timezone),
        capacity: patch.capacity === undefined ? undefined : capacity(patch.capacity),
      }, 'patch');
    }),
    publish: (eventId: string) => update('events.publish', eventId, () => ({ status: 'published' })),
    cancel: (eventId: string, reason?: string) => update('events.cancel', eventId, () => ({
      status: 'cancelled', cancellation_reason: v.optionalText(reason, 'reason', { max: 500 }) ?? null,
    })),
    complete: (eventId: string) => update('events.complete', eventId, () => ({ status: 'completed' })),

    /**
     * RSVP as the caller. 'going' on a full event joins the waitlist; the
     * returned status says which. Atomic and race-safe in the database.
     */
    rsvp(eventId: string, status: (typeof RSVP_STATUSES)[number]): Promise<{ status: string; waitlistedAt: string | null }> {
      return ctx.run('events.rsvp', async () => {
        await ctx.requireUserId();
        const row = firstRow(unwrap(await db.rpc('rsvp_to_event', {
          p_event_id: v.uuid(eventId, 'eventId'),
          p_status: v.oneOf(status, 'status', RSVP_STATUSES),
        })), 'Event not found.');
        return { status: row.status, waitlistedAt: row.waitlisted_at };
      });
    },

    /** Removes the caller's RSVP; a freed place goes to the next person on the waitlist. */
    cancelRsvp(eventId: string): Promise<boolean> {
      return ctx.run('events.cancelRsvp', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('cancel_rsvp', { p_event_id: v.uuid(eventId, 'eventId') })) as boolean;
      });
    },

    /** Totals, places left, and the caller's own status and waitlist position. */
    attendance(eventId: string): Promise<Attendance> {
      return ctx.run('events.attendance', async () => {
        await ctx.requireUserId();
        return firstRow(unwrap(await db.rpc('get_event_attendance', { p_event_id: v.uuid(eventId, 'eventId') })), 'Event not found.');
      });
    },

    /** Published events that have not ended, soonest first. */
    listUpcoming(input: { communityId: string } & PageRequest): Promise<Page<CommunityEvent>> {
      return ctx.run('events.listUpcoming', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_upcoming_events', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_starts_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.starts_at, last.id]);
      });
    },

    /** Events that are over (completed, or ended), newest first. */
    listPast(input: { communityId: string } & PageRequest): Promise<Page<CommunityEvent>> {
      return ctx.run('events.listPast', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_past_events', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_starts_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.starts_at, last.id]);
      });
    },

    /**
     * The organizer's display name: the event's creator, read through the
     * profiles RLS (co-members with members.view). null when the account was
     * deleted (created_by is NULL), has no name, or is not visible to the caller.
     */
    organizerName(createdBy: string | null): Promise<string | null> {
      return ctx.run('events.organizerName', async () => {
        await ctx.requireUserId();
        if (createdBy === null) return null;
        const row = unwrap(await db.from('profiles').select('display_name').eq('id', v.uuid(createdBy, 'createdBy')).maybeSingle());
        return row?.display_name ?? null;
      });
    },

    /** Calendar / history window. */
    list(input: { communityId: string; from?: string | Date; to?: string | Date; statuses?: (typeof EVENT_STATUSES)[number][] } & PageRequest): Promise<Page<CommunityEvent>> {
      return ctx.run('events.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'from', 'to', 'statuses', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_events', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_from: v.optionalDateTime(input.from, 'from') ?? undefined,
          p_to: v.optionalDateTime(input.to, 'to') ?? undefined,
          p_statuses: input.statuses === undefined ? undefined : v.enumList(input.statuses, 'statuses', EVENT_STATUSES),
          p_limit: limit,
          p_cursor_starts_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.starts_at, last.id]);
      });
    },
  };
}

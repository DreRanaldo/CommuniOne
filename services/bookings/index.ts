// Service bookings (Stage J, migration 38). Times are ISO timestamps; the
// server checks the seller's hours, time off and existing bookings, fixes
// the amount when the seller accepts, and never lets two accepted bookings
// overlap.

import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import { unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, ServiceError } from '../core/errors.ts';
import type { Tables } from '../database.types.ts';
import * as v from '../core/validate.ts';

export type BookingRow = Tables<'bookings'>;
export type BookingEvent = Tables<'booking_events'>;
export type AvailabilityWindow = { weekday: number; start: string; end: string };

export interface Booking extends Omit<BookingRow, 'period'> {
  startsAt: string;
  endsAt: string;
}

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  requested: 'Waiting for the seller',
  proposed: 'The seller proposed another time',
  accepted: 'Accepted: pay to confirm',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
  completed: 'Completed',
};

/** "[2026-10-20 14:00:00+00,2026-10-20 15:00:00+00)" -> ISO start/end. */
export function parsePeriod(period: string): { startsAt: string; endsAt: string } {
  const m = /^[[(]"?([^",]+)"?,"?([^",]+)"?[)\]]$/.exec(period ?? '');
  if (!m) throw new ServiceError(ErrorCode.ServerError);
  const iso = (x: string) => new Date(x.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString();
  return { startsAt: iso(m[1]!), endsAt: iso(m[2]!) };
}

const toBooking = ({ period, ...row }: BookingRow): Booking => ({ ...row, ...parsePeriod(period as unknown as string) });
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function bookingsService(ctx: ServiceContext) {
  const { db } = ctx;
  const call = <T>(operation: string, run: () => Promise<T>) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      return run();
    });
  const rpc = (operation: string, fn: string, args: () => Record<string, unknown>) =>
    call(operation, async () => {
      unwrap(await db.rpc(fn as never, args() as never));
    });
  const iso = (value: string, field: string) => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) v.fail(field, 'Choose a date and time.');
    return new Date(value).toISOString();
  };

  return {
    /** A seller's weekly hours (empty: any time). */
    availability(sellerProfileId: string): Promise<AvailabilityWindow[]> {
      return call('bookings.availability', async () => {
        const rows = unwrap(await db.from('service_availability').select('weekday, start_time, end_time')
          .eq('seller_profile_id', v.uuid(sellerProfileId, 'sellerProfileId')).order('weekday').order('start_time')) ?? [];
        return rows.map((r) => ({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }));
      });
    },

    /** Seller: replace the weekly hours. */
    saveAvailability(sellerProfileId: string, windows: AvailabilityWindow[]): Promise<void> {
      return rpc('bookings.saveAvailability', 'service_availability_save', () => {
        if (!Array.isArray(windows) || windows.length > 50) v.fail('windows', 'Up to 50 time windows.');
        return {
          p_seller_profile_id: v.uuid(sellerProfileId, 'sellerProfileId'),
          p_windows: windows.map((w, i) => {
            const start = v.text(w.start, `windows[${i}].start`, { max: 5, pattern: TIME, patternMessage: 'Use HH:MM.' });
            const end = v.text(w.end, `windows[${i}].end`, { max: 5, pattern: TIME, patternMessage: 'Use HH:MM.' });
            if (end <= start) v.fail(`windows[${i}].end`, 'The end must be after the start.');
            return { weekday: v.int(w.weekday, `windows[${i}].weekday`, 0, 6), start, end };
          }),
        };
      });
    },

    /** Busy times of a seller between two instants (no details). */
    busy(sellerProfileId: string, from: string, to: string): Promise<{ startsAt: string; endsAt: string }[]> {
      return call('bookings.busy', async () => {
        const rows = unwrap(await db.rpc('seller_busy_times', {
          p_seller_profile_id: v.uuid(sellerProfileId, 'sellerProfileId'), p_from: iso(from, 'from'), p_to: iso(to, 'to'),
        })) ?? [];
        return rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
      });
    },

    /** Buyer: ask to book a service. Returns the booking id. */
    request(input: { listingId: string; startsAt: string; endsAt: string; note?: string | null; locationNote?: string | null }): Promise<string> {
      return call('bookings.request', async () => {
        const id = unwrap(await db.rpc('booking_request', {
          p_listing_id: v.uuid(input.listingId, 'listingId'),
          p_starts_at: iso(input.startsAt, 'startsAt'),
          p_ends_at: iso(input.endsAt, 'endsAt'),
          p_note: v.optionalText(input.note, 'note', { max: 1000 }) ?? undefined,
          p_location_note: v.optionalText(input.locationNote, 'locationNote', { max: 300 }) ?? undefined,
        }));
        if (typeof id !== 'string') throw new ServiceError(ErrorCode.ServerError);
        return id;
      });
    },

    /** The caller's bookings in a community: as buyer, or as seller. */
    list(input: { communityId: string; as: 'buyer' | 'seller' } & PageRequest): Promise<Page<Booking>> {
      return call('bookings.list', async () => {
        const userId = await ctx.requireUserId();
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        let q = db.from('bookings').select('*').eq('community_id', v.uuid(input.communityId, 'communityId'))
          .eq(input.as === 'seller' ? 'seller_user_id' : 'buyer_user_id', userId)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
        if (cursor) {
          const [at, id] = cursor as [string, string];
          q = q.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
        }
        const rows = (unwrap(await q) ?? []).map(toBooking);
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },

    booking(bookingId: string): Promise<{ booking: Booking; events: BookingEvent[]; role: 'buyer' | 'seller' }> {
      return call('bookings.get', async () => {
        const userId = await ctx.requireUserId();
        const id = v.uuid(bookingId, 'bookingId');
        const row = unwrapOne(await db.from('bookings').select('*').eq('id', id).maybeSingle(), 'Booking not found.');
        const events = unwrap(await db.from('booking_events').select('*').eq('booking_id', id).order('created_at')) ?? [];
        return { booking: toBooking(row), events, role: row.buyer_user_id === userId ? 'buyer' : 'seller' };
      });
    },

    /** Seller: accept; quote-priced services need a price. */
    accept(bookingId: string, priceMinor?: number | null): Promise<void> {
      return rpc('bookings.accept', 'booking_accept', () => ({
        p_booking_id: v.uuid(bookingId, 'bookingId'),
        p_price_minor: priceMinor == null ? undefined : v.int(priceMinor, 'priceMinor', 1, 100_000_000),
      }));
    },
    propose(bookingId: string, startsAt: string, endsAt: string, note?: string | null): Promise<void> {
      return rpc('bookings.propose', 'booking_propose', () => ({
        p_booking_id: v.uuid(bookingId, 'bookingId'), p_starts_at: iso(startsAt, 'startsAt'), p_ends_at: iso(endsAt, 'endsAt'),
        p_note: v.optionalText(note, 'note', { max: 500 }) ?? undefined,
      }));
    },
    acceptProposal(bookingId: string): Promise<void> {
      return rpc('bookings.acceptProposal', 'booking_accept_proposal', () => ({ p_booking_id: v.uuid(bookingId, 'bookingId') }));
    },
    decline(bookingId: string, reason: string): Promise<void> {
      return rpc('bookings.decline', 'booking_decline', () => ({ p_booking_id: v.uuid(bookingId, 'bookingId'), p_reason: v.text(reason, 'reason', { min: 3, max: 500 }) }));
    },
    cancel(bookingId: string, reason: string): Promise<void> {
      return rpc('bookings.cancel', 'booking_cancel', () => ({ p_booking_id: v.uuid(bookingId, 'bookingId'), p_reason: v.text(reason, 'reason', { min: 3, max: 500 }) }));
    },
    complete(bookingId: string): Promise<void> {
      return rpc('bookings.complete', 'booking_complete', () => ({ p_booking_id: v.uuid(bookingId, 'bookingId') }));
    },
    openDispute(bookingId: string, reason: string): Promise<string> {
      return call('bookings.openDispute', async () => {
        const id = unwrap(await db.rpc('booking_dispute_open', { p_booking_id: v.uuid(bookingId, 'bookingId'), p_reason: v.text(reason, 'reason', { min: 10, max: 2000 }) }));
        if (typeof id !== 'string') throw new ServiceError(ErrorCode.ServerError);
        return id;
      });
    },
  };
}

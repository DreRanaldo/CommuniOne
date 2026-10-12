// Display rules for events and RSVPs. Who may do what, capacity and the
// waitlist are decided by the database (RLS, enforce_event_write(),
// apply_rsvp_capacity()); these helpers only decide which controls to show
// and how to describe an event. Times are shown in the event's time zone.
import { ErrorCode, isServiceError } from '@communione/services';
import type { IconName } from '@/components';
import { errorMessage } from '@/utils/errors';

export interface EventLike {
  status: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  capacity: number | null;
  created_by: string | null;
}

type Can = (key: string) => boolean;

// ---- Time zones (built-in Intl; no date library) ----

/** Whether `timeZone` is an IANA zone this device knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The device's own zone (fallback for new events). */
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall clock in `timeZone` at an instant. */
function wallClock(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The instant at which the wall clock in `timeZone` shows this date and time. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms: number) => {
    const w = wallClock(ms, timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
  };
  // Two passes settle the offset around daylight-saving changes.
  let ms = target - offsetAt(target);
  ms = target - offsetAt(ms);
  return new Date(ms);
}

/** An instant as the editor's date and time fields in `timeZone`. */
export function utcToZonedFields(iso: string, timeZone: string): { date: string; time: string } {
  const w = wallClock(Date.parse(iso), timeZone);
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

function format(iso: string, options: Intl.DateTimeFormatOptions, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
  }
}

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/** Date, time range and zone, in the event's time zone. */
export function eventSchedule(e: Pick<EventLike, 'starts_at' | 'ends_at' | 'timezone'>) {
  const sameDay = format(e.starts_at, DAY, e.timezone) === format(e.ends_at, DAY, e.timezone);
  return {
    date: sameDay
      ? format(e.starts_at, DAY, e.timezone)
      : `${format(e.starts_at, DAY, e.timezone)} – ${format(e.ends_at, DAY, e.timezone)}`,
    time: `${format(e.starts_at, TIME, e.timezone)} – ${format(e.ends_at, TIME, e.timezone)}`,
    timezone: e.timezone,
  };
}

/** The start in the device's zone, when that differs from the event's (null otherwise). */
export function localStartNote(
  e: Pick<EventLike, 'starts_at' | 'timezone'>,
  here = deviceTimeZone(),
): string | null {
  if (here === e.timezone) return null;
  if (format(e.starts_at, { ...DAY, ...TIME }, here) === format(e.starts_at, { ...DAY, ...TIME }, e.timezone))
    return null;
  return `Your time: ${format(e.starts_at, { ...DAY, ...TIME }, here)}`;
}

// ---- State ----

export const hasStarted = (e: Pick<EventLike, 'starts_at'>, now = Date.now()) =>
  Date.parse(e.starts_at) <= now;
export const hasEnded = (e: Pick<EventLike, 'ends_at'>, now = Date.now()) => Date.parse(e.ends_at) <= now;

/** A short status label, or null for an upcoming published event. */
export function statusBadge(e: EventLike, now = Date.now()): string | null {
  if (e.status === 'draft') return 'Draft';
  if (e.status === 'cancelled') return 'Cancelled';
  if (e.status === 'completed') return 'Completed';
  if (hasEnded(e, now)) return 'Ended';
  if (hasStarted(e, now)) return 'Happening now';
  return null;
}

/** RSVPs are open while the event is published and has not started (private.can_rsvp). */
export const rsvpOpen = (e: EventLike, now = Date.now()) => e.status === 'published' && !hasStarted(e, now);

/** Why replies are closed (null when open). */
export function rsvpClosedReason(e: EventLike, now = Date.now()): string | null {
  if (e.status === 'draft') return 'Replies open when the event is published.';
  if (e.status === 'cancelled') return 'This event was cancelled. Replies are closed.';
  if (e.status === 'completed') return 'This event is over. Replies are closed.';
  if (hasStarted(e, now)) return 'This event has started. Replies are closed.';
  return null;
}

// ---- RSVP and capacity ----

/**
 * get_event_attendance() row. The generated types mark these columns as
 * non-null, but capacity / spots_left are NULL for unlimited events and
 * my_status / my_waitlist_position are NULL until the caller replies.
 */
export interface AttendanceLike {
  capacity: number | null;
  going_count: number;
  waitlisted_count: number;
  spots_left: number | null;
  my_status: string | null;
  my_waitlist_position: number | null;
}

export type RsvpChoice = 'going' | 'maybe' | 'not_going';
export const RSVP_CHOICES: { value: RsvpChoice; label: string; icon: IconName }[] = [
  { value: 'going', label: 'Going', icon: 'checkmark-circle-outline' },
  { value: 'maybe', label: 'Maybe', icon: 'help-circle-outline' },
  { value: 'not_going', label: 'Not going', icon: 'close-circle-outline' },
];
export const RSVP_LABELS: Record<string, string> = {
  going: 'Going',
  maybe: 'Maybe',
  not_going: 'Not going',
  waitlisted: 'Waitlisted',
};

/** The caller's own reply, in words (from get_event_attendance). */
export function myRsvpText(a: Pick<AttendanceLike, 'my_status' | 'my_waitlist_position'>): string {
  switch (a.my_status) {
    case 'going':
      return "You're going.";
    case 'maybe':
      return 'You might go.';
    case 'not_going':
      return "You're not going.";
    case 'waitlisted':
      return `You're on the waitlist${a.my_waitlist_position ? ` (number ${a.my_waitlist_position})` : ''}. You get a place automatically if one frees up.`;
    default:
      return "You haven't replied yet.";
  }
}

/** Places and waitlist, as the server counted them. */
export function capacityText(
  a: Pick<AttendanceLike, 'capacity' | 'going_count' | 'waitlisted_count' | 'spots_left'>,
): string {
  if (a.capacity === null) return `${a.going_count} going · No limit on places`;
  if (a.spots_left === 0) {
    const waiting = a.waitlisted_count > 0 ? ` · ${a.waitlisted_count} on the waitlist` : '';
    return `Full · ${a.going_count} of ${a.capacity} places taken${waiting}`;
  }
  return `${a.going_count} of ${a.capacity} places taken · ${a.spots_left} left`;
}

// ---- Who sees which controls (display only) ----

/** The "New" button (insert RLS requires events.create). */
export const canCreate = (can: Can) => can('events.create');
/** The Drafts view: managers see all drafts, organizers their own. */
export const canSeeDrafts = (can: Can) => can('events.create') || can('events.manage');

/** Management controls: events.manage for any event; events.create for your own. */
export function canManage(e: EventLike, viewerId: string | null, can: Can): boolean {
  return can('events.manage') || (viewerId !== null && e.created_by === viewerId && can('events.create'));
}

export type EventAction = 'edit' | 'publish' | 'discard' | 'cancel' | 'complete';

/** Lifecycle actions (the trigger's transitions). Complete only once it has started. */
export function lifecycleActions(e: EventLike, now = Date.now()): EventAction[] {
  if (e.status === 'draft') return hasEnded(e, now) ? ['edit', 'discard'] : ['edit', 'publish', 'discard'];
  if (e.status === 'published')
    return hasStarted(e, now) ? ['edit', 'cancel', 'complete'] : ['edit', 'cancel'];
  return [];
}

/** Server refusals explained in plain words. */
export function eventError(error: unknown): string {
  if (isServiceError(error)) {
    const m = error.message;
    if (/cannot RSVP/i.test(m))
      return 'Replies are closed for this event. It may have started or been cancelled.';
    if (/capacity .* cannot be lower/i.test(m))
      return 'More people are already going than that. Choose a larger number of places.';
    if (/already ended cannot be published/i.test(m))
      return 'This event has already ended, so it cannot be published.';
    if (/cannot be completed before it starts/i.test(m))
      return 'An event can be completed only once it has started.';
    if (/time_order|endsAt must not be before/i.test(m)) return 'The event must end after it starts.';
    if (/invalid event transition|cannot be modified|only draft or published|reason can only/i.test(m))
      return 'This event has changed meanwhile. Go back and open it again.';
    if (error.code === ErrorCode.Forbidden) return "You don't have permission to change this event.";
    if (error.code === ErrorCode.NotFound) return 'This event is no longer available.';
  }
  return errorMessage(error);
}

// ---- Editor ----

export interface EventFormText {
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  capacity: string;
}
export type EventFormField = keyof EventFormText;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function parseDate(text: string): [number, number, number] | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return [y, mo, d];
}
function parseTime(text: string): [number, number] | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h > 23 || min > 59 ? null : [h, min];
}

/**
 * Editor fields → start, end (ISO), time zone and capacity. Times are wall
 * clock times in the chosen zone; without an end date the event ends on its
 * start day. Checked again by the database.
 */
export function parseEventForm(
  f: EventFormText,
):
  | { value: { startsAt: string; endsAt: string; timeZone: string; capacity: number | null } }
  | { errors: Partial<Record<EventFormField, string>> } {
  const errors: Partial<Record<EventFormField, string>> = {};
  const timeZone = f.timeZone.trim();
  if (!isValidTimeZone(timeZone))
    errors.timeZone = 'Use a time zone such as Europe/London or America/Chicago.';
  const date = f.date.trim() ? parseDate(f.date) : null;
  if (!f.date.trim()) errors.date = 'Choose a date.';
  else if (!date) errors.date = 'Use the format YYYY-MM-DD, e.g. 2026-12-31.';
  const start = parseTime(f.startTime);
  if (!start) errors.startTime = 'Use the format HH:MM, e.g. 18:30.';
  const end = parseTime(f.endTime);
  if (!end) errors.endTime = 'Use the format HH:MM, e.g. 20:00.';
  const endDate = f.endDate.trim() ? parseDate(f.endDate) : date;
  if (f.endDate.trim() && !endDate) errors.endDate = 'Use the format YYYY-MM-DD, or leave it empty.';
  let capacity: number | null = null;
  if (f.capacity.trim()) {
    const n = Number(f.capacity.trim());
    if (!/^\d+$/.test(f.capacity.trim()) || n < 1 || n > 100_000)
      errors.capacity = 'Enter a whole number from 1 to 100,000, or leave it empty for no limit.';
    else capacity = n;
  }
  if (Object.keys(errors).length > 0 || !date || !start || !end || !endDate) return { errors };
  const startsAt = zonedTimeToUtc(date[0], date[1], date[2], start[0], start[1], timeZone);
  const endsAt = zonedTimeToUtc(endDate[0], endDate[1], endDate[2], end[0], end[1], timeZone);
  if (endsAt.getTime() < startsAt.getTime())
    return { errors: { endTime: 'The event must end after it starts.' } };
  return { value: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), timeZone, capacity } };
}

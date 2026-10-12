import { ErrorCode, ServiceError } from '@communione/services';
import {
  canManage,
  capacityText,
  eventError,
  isValidTimeZone,
  lifecycleActions,
  myRsvpText,
  parseEventForm,
  rsvpOpen,
  statusBadge,
  utcToZonedFields,
  zonedTimeToUtc,
} from './eventRules';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const base = {
  status: 'published',
  starts_at: at(24),
  ends_at: at(26),
  timezone: 'UTC',
  capacity: null,
  created_by: 'me',
};
const can =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);

test('wall-clock times in a zone ⇄ UTC, including daylight saving', () => {
  expect(zonedTimeToUtc(2026, 7, 1, 18, 0, 'Europe/London').toISOString()).toBe('2026-07-01T17:00:00.000Z'); // BST
  expect(zonedTimeToUtc(2026, 12, 1, 18, 0, 'Europe/London').toISOString()).toBe('2026-12-01T18:00:00.000Z'); // GMT
  expect(zonedTimeToUtc(2026, 3, 8, 12, 0, 'America/Chicago').toISOString()).toBe('2026-03-08T17:00:00.000Z'); // CDT, DST day
  expect(zonedTimeToUtc(2026, 1, 15, 9, 30, 'Asia/Kolkata').toISOString()).toBe('2026-01-15T04:00:00.000Z'); // +05:30
  expect(utcToZonedFields('2026-07-01T17:00:00.000Z', 'Europe/London')).toEqual({
    date: '2026-07-01',
    time: '18:00',
  });
  expect(isValidTimeZone('Europe/London')).toBe(true);
  expect(isValidTimeZone('Mars/Base')).toBe(false);
  expect(isValidTimeZone("UTC'; drop table")).toBe(false);
});

test('the form: required fields, formats, end after start, places', () => {
  const ok = parseEventForm({
    date: '2026-12-01',
    startTime: '18:00',
    endDate: '',
    endTime: '20:30',
    timeZone: 'Europe/London',
    capacity: '',
  });
  expect(ok).toEqual({
    value: {
      startsAt: '2026-12-01T18:00:00.000Z',
      endsAt: '2026-12-01T20:30:00.000Z',
      timeZone: 'Europe/London',
      capacity: null,
    },
  });
  const overnight = parseEventForm({
    date: '2026-12-31',
    startTime: '22:00',
    endDate: '2027-01-01',
    endTime: '01:00',
    timeZone: 'UTC',
    capacity: '50',
  });
  expect('value' in overnight && overnight.value.capacity).toBe(50);
  expect(
    parseEventForm({
      date: '2026-12-01',
      startTime: '20:00',
      endDate: '',
      endTime: '19:00',
      timeZone: 'UTC',
      capacity: '',
    }),
  ).toEqual({ errors: { endTime: 'The event must end after it starts.' } });
  const bad = parseEventForm({
    date: '2026-02-30',
    startTime: '25:00',
    endDate: 'x',
    endTime: '',
    timeZone: 'Nope',
    capacity: '1.5',
  });
  expect(Object.keys('errors' in bad ? bad.errors : {}).sort()).toEqual([
    'capacity',
    'date',
    'endDate',
    'endTime',
    'startTime',
    'timeZone',
  ]);
});

test('status and when replies are open', () => {
  expect(statusBadge(base, NOW)).toBeNull();
  expect(statusBadge({ ...base, starts_at: at(-1) }, NOW)).toBe('Happening now');
  expect(statusBadge({ ...base, starts_at: at(-3), ends_at: at(-1) }, NOW)).toBe('Ended');
  expect(statusBadge({ ...base, status: 'cancelled' }, NOW)).toBe('Cancelled');
  expect(statusBadge({ ...base, status: 'completed' }, NOW)).toBe('Completed');
  expect(rsvpOpen(base, NOW)).toBe(true);
  expect(rsvpOpen({ ...base, starts_at: at(-1) }, NOW)).toBe(false);
  expect(rsvpOpen({ ...base, status: 'draft' }, NOW)).toBe(false);
});

test('capacity and my reply, from the server counts', () => {
  const counts = { capacity: 10, going_count: 4, waitlisted_count: 0, spots_left: 6 };
  expect(capacityText(counts)).toBe('4 of 10 places taken · 6 left');
  expect(capacityText({ capacity: 2, going_count: 2, waitlisted_count: 3, spots_left: 0 })).toBe(
    'Full · 2 of 2 places taken · 3 on the waitlist',
  );
  expect(capacityText({ capacity: null, going_count: 7, waitlisted_count: 0, spots_left: null })).toBe(
    '7 going · No limit on places',
  );
  expect(myRsvpText({ my_status: 'waitlisted', my_waitlist_position: 3 })).toMatch(/waitlist \(number 3\)/);
  expect(myRsvpText({ my_status: null, my_waitlist_position: null })).toBe("You haven't replied yet.");
});

test('controls: managers any event, organizers their own; lifecycle by status and time', () => {
  expect(canManage(base, 'me', can('events.create'))).toBe(true);
  expect(canManage(base, 'you', can('events.create'))).toBe(false);
  expect(canManage(base, 'you', can('events.manage'))).toBe(true);
  expect(canManage(base, 'me', can('events.view'))).toBe(false);
  expect(lifecycleActions({ ...base, status: 'draft' }, NOW)).toEqual(['edit', 'publish', 'discard']);
  expect(lifecycleActions(base, NOW)).toEqual(['edit', 'cancel']);
  expect(lifecycleActions({ ...base, starts_at: at(-1) }, NOW)).toEqual(['edit', 'cancel', 'complete']);
  expect(lifecycleActions({ ...base, status: 'cancelled' }, NOW)).toEqual([]);
});

test('server refusals in plain words', () => {
  const refusal = (code: ErrorCode, message: string) => eventError(new ServiceError(code, message));
  expect(refusal(ErrorCode.Forbidden, 'you cannot RSVP to this event')).toMatch(/Replies are closed/);
  expect(
    refusal(ErrorCode.Validation, 'capacity (1) cannot be lower than the number of people going (2)'),
  ).toMatch(/already going/);
  expect(refusal(ErrorCode.Validation, 'an event cannot be completed before it starts')).toMatch(/started/);
  expect(refusal(ErrorCode.Validation, 'invalid event transition: cancelled -> published')).toMatch(
    /changed/,
  );
  expect(refusal(ErrorCode.Forbidden, 'nope')).toMatch(/permission/);
  expect(refusal(ErrorCode.NotFound, 'Event not found.')).toMatch(/no longer available/);
});

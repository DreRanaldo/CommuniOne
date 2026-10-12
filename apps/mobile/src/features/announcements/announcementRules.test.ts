import { ErrorCode, ServiceError } from '@communione/services';
import {
  announcementDates,
  announcementError,
  canManage,
  formatExpiryDate,
  lifecycleActions,
  parseExpiryDate,
  statusBadge,
} from './announcementRules';

const base = {
  status: 'published',
  priority: 'normal',
  published_at: '2026-10-01T10:00:00Z',
  expires_at: null,
  edited_at: null,
  author_user_id: 'me',
};
const NOW = Date.parse('2026-10-12T12:00:00Z');

test('lifecycle actions follow the database transitions', () => {
  expect(lifecycleActions('draft')).toEqual(['edit', 'publish', 'delete']);
  expect(lifecycleActions('published')).toEqual(['edit', 'archive', 'delete']);
  expect(lifecycleActions('archived')).toEqual(['republish', 'delete']);
  expect(lifecycleActions('deleted')).toEqual([]);
});

test('who may manage: managers any, authors their own with announcements.create', () => {
  const can = (keys: string[]) => (key: string) => keys.includes(key);
  expect(canManage(base, 'someone', can(['announcements.manage']))).toBe(true);
  expect(canManage(base, 'me', can(['announcements.create']))).toBe(true);
  expect(canManage(base, 'someone', can(['announcements.create']))).toBe(false);
  expect(canManage(base, 'me', can(['announcements.view']))).toBe(false);
  expect(canManage(base, null, can(['announcements.create']))).toBe(false);
});

test('badges and dates', () => {
  expect(statusBadge(base, NOW)).toBeNull();
  expect(statusBadge({ ...base, status: 'draft' }, NOW)).toBe('Draft');
  expect(statusBadge({ ...base, status: 'archived' }, NOW)).toBe('Archived');
  expect(statusBadge({ ...base, expires_at: '2026-10-11T00:00:00Z' }, NOW)).toBe('Expired');
  expect(announcementDates({ ...base, status: 'draft', published_at: null }, NOW)).toBe(
    'Draft, not published',
  );
  expect(
    announcementDates(
      { ...base, edited_at: '2026-10-02T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' },
      NOW,
    ),
  ).toMatch(/^Published .* · Edited · Expires /);
});

test('expiry dates: YYYY-MM-DD, end of that day, in the future', () => {
  expect(parseExpiryDate('')).toEqual({ value: null });
  expect(parseExpiryDate('31/12/2099')).toEqual({ error: 'Use the format YYYY-MM-DD, e.g. 2026-12-31.' });
  expect(parseExpiryDate('2099-02-30')).toEqual({ error: 'That date does not exist.' });
  expect(parseExpiryDate('2001-01-01')).toEqual({ error: 'Choose a date in the future.' });
  const parsed = parseExpiryDate('2099-12-31') as { value: string };
  expect(new Date(parsed.value).getHours()).toBe(23);
  expect(formatExpiryDate(parsed.value)).toBe('2099-12-31');
});

test('server refusals in plain words', () => {
  const e = (code: ErrorCode, message?: string) => announcementError(new ServiceError(code, message));
  expect(e(ErrorCode.Validation, 'Expires_at must be in the future when publishing')).toMatch(
    /expiry date has passed/,
  );
  expect(e(ErrorCode.Validation, 'Invalid announcement transition: draft -> archived')).toMatch(
    /changed meanwhile/,
  );
  expect(e(ErrorCode.Forbidden)).toMatch(/permission/);
  expect(e(ErrorCode.NotFound)).toMatch(/no longer available/);
});

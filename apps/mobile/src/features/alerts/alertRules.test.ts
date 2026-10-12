import { ServiceError, ErrorCode } from '@communione/services';
import {
  alertError,
  alertState,
  canChangeSeverity,
  canManage,
  formatAlertEnd,
  isActive,
  lifecycleActions,
  parseAlertEnd,
  SEVERITY_INFO,
  severityChoices,
  severityOf,
} from './alertRules';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const base = {
  severity: 'warning',
  published_at: '2026-10-12T10:00:00Z',
  expires_at: null,
  created_by: 'me',
};
const can =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);

test('each severity has a distinct icon and label; unknown values read as information', () => {
  const icons = Object.values(SEVERITY_INFO).map((s) => s.icon);
  const labels = Object.values(SEVERITY_INFO).map((s) => s.label);
  expect(new Set(icons).size).toBe(4);
  expect(new Set(labels).size).toBe(4);
  expect(severityOf('emergency')).toBe('emergency');
  expect(severityOf('apocalypse')).toBe('info');
});

test('state: active until the end time; then ended; drafts, cancelled and archived as such', () => {
  expect(isActive({ ...base, status: 'published' }, NOW)).toBe(true);
  expect(alertState({ ...base, status: 'published', expires_at: '2026-10-12T11:59:00Z' }, NOW)).toBe('ended');
  expect(alertState({ ...base, status: 'expired' }, NOW)).toBe('ended');
  expect(alertState({ ...base, status: 'cancelled' }, NOW)).toBe('cancelled');
  expect(alertState({ ...base, status: 'archived' }, NOW)).toBe('archived');
  expect(alertState({ ...base, status: 'draft' }, NOW)).toBe('draft');
});

test('controls: managers any alert, creators their own; emergency needs alerts.manage', () => {
  expect(canManage(base, 'me', can('alerts.create'))).toBe(true);
  expect(canManage(base, 'you', can('alerts.create'))).toBe(false);
  expect(canManage(base, 'you', can('alerts.manage'))).toBe(true);
  expect(canManage(base, 'me', can('alerts.view'))).toBe(false);
  expect(severityChoices(can('alerts.create'))).not.toContain('emergency');
  expect(severityChoices(can('alerts.manage'))).toContain('emergency');
  expect(severityChoices(can('alerts.create'), 'emergency')).toEqual(['emergency']);
  const draft = { ...base, status: 'draft' };
  expect(canChangeSeverity(draft, can('alerts.create'))).toBe(true);
  expect(canChangeSeverity({ ...base, status: 'published' }, can('alerts.create'))).toBe(false);
  expect(lifecycleActions({ ...draft, severity: 'emergency' }, can('alerts.create'))).toEqual([
    'edit',
    'discard',
  ]);
  expect(lifecycleActions({ ...draft, severity: 'emergency' }, can('alerts.manage'))).toContain('publish');
  expect(lifecycleActions({ ...base, status: 'published' }, can())).toEqual(['edit', 'end', 'cancel']);
  expect(lifecycleActions({ ...base, status: 'expired' }, can())).toEqual(['archive']);
  expect(lifecycleActions({ ...base, status: 'archived' }, can('alerts.manage'))).toEqual([]);
});

test('end time: date and optional time, in the future', () => {
  expect(parseAlertEnd('', '', NOW)).toEqual({ value: null });
  expect(parseAlertEnd('', '10:00', NOW)).toMatchObject({ field: 'date' });
  expect(parseAlertEnd('2026-02-30', '', NOW)).toMatchObject({ error: 'That date does not exist.' });
  expect(parseAlertEnd('2026-12-01', '25:00', NOW)).toMatchObject({ field: 'time' });
  expect(parseAlertEnd('2020-01-01', '', NOW)).toMatchObject({ error: 'Choose a time in the future.' });
  const end = parseAlertEnd('2026-12-01', '18:30', NOW);
  expect('value' in end && formatAlertEnd(end.value)).toEqual({ date: '2026-12-01', time: '18:30' });
  const endOfDay = parseAlertEnd('2026-12-01', '', NOW);
  expect('value' in endOfDay && formatAlertEnd(endOfDay.value).time).toBe('23:59');
});

test('server refusals in plain words', () => {
  const refusal = (code: ErrorCode, message: string) => alertError(new ServiceError(code, message));
  expect(refusal(ErrorCode.Validation, 'expires_at must be in the future when publishing')).toMatch(
    /end time/,
  );
  expect(refusal(ErrorCode.Forbidden, 'emergency alerts require alerts.manage')).toMatch(/emergency/);
  expect(refusal(ErrorCode.Validation, 'invalid alert transition: expired -> published')).toMatch(/changed/);
  expect(refusal(ErrorCode.Forbidden, 'nope')).toMatch(/permission/);
  expect(refusal(ErrorCode.NotFound, 'Alert not found.')).toMatch(/no longer available/);
});

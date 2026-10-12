// Display rules for alerts. Who may do what is decided by the database (RLS +
// enforce_alert_write()); these helpers only decide which controls to show
// and how to describe an alert. Severity is never told by colour alone: each
// level has its own icon, label and wording.
import { ErrorCode, isServiceError } from '@communione/services';
import type { IconName } from '@/components';
import { errorMessage } from '@/utils/errors';
import { formatDateTime } from '@/utils/format';

export type Severity = 'info' | 'warning' | 'urgent' | 'emergency';

export const SEVERITIES: Severity[] = ['emergency', 'urgent', 'warning', 'info'];

export const SEVERITY_INFO: Record<Severity, { label: string; icon: IconName; description: string }> = {
  emergency: {
    label: 'Emergency',
    icon: 'alert-circle',
    description: 'Immediate danger to life, health or property. Act now.',
  },
  urgent: { label: 'Urgent', icon: 'warning', description: 'Serious; act soon.' },
  warning: { label: 'Warning', icon: 'warning-outline', description: 'May affect you; be prepared.' },
  info: { label: 'Information', icon: 'information-circle-outline', description: 'Good to know.' },
};

/** Unknown values are shown as information (never as something more alarming). */
export const severityOf = (value: string): Severity =>
  (SEVERITIES as string[]).includes(value) ? (value as Severity) : 'info';

export interface AlertLike {
  status?: string;
  severity: string;
  published_at: string | null;
  expires_at: string | null;
  expired_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  archived_at?: string | null;
  edited_at?: string | null;
  created_by?: string | null;
}

const statusOf = (a: AlertLike) => a.status ?? 'published';

/** Published and not past its end time: what list_active_alerts() returns. */
export const isActive = (a: AlertLike, now = Date.now()) =>
  statusOf(a) === 'published' && (!a.expires_at || Date.parse(a.expires_at) > now);

/** Where the alert is in its life, as members understand it. */
export function alertState(
  a: AlertLike,
  now = Date.now(),
): 'draft' | 'active' | 'ended' | 'cancelled' | 'archived' {
  const status = statusOf(a);
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'archived') return 'archived';
  return isActive(a, now) ? 'active' : 'ended';
}

const BADGES = {
  draft: 'Draft',
  active: 'Active',
  ended: 'Ended',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

/** A short status label (always shown in history and detail). */
export const statusBadge = (a: AlertLike, now = Date.now()) => BADGES[alertState(a, now)];

/** One line under the title: issued, updated, end, cancellation, archive. */
export function alertDates(a: AlertLike, timeZone?: string, now = Date.now()): string {
  const parts: string[] = [];
  const status = statusOf(a);
  if (status === 'draft') parts.push('Draft, not issued');
  else if (a.published_at) parts.push(`Issued ${formatDateTime(a.published_at, timeZone)}`);
  if (a.edited_at && status !== 'draft') parts.push('Updated');
  if (status === 'cancelled' && a.cancelled_at)
    parts.push(`Cancelled ${formatDateTime(a.cancelled_at, timeZone)}`);
  else if (a.expired_at) parts.push(`Ended ${formatDateTime(a.expired_at, timeZone)}`);
  else if (a.expires_at) {
    const passed = Date.parse(a.expires_at) <= now;
    parts.push(`${passed ? 'Ended' : 'Ends'} ${formatDateTime(a.expires_at, timeZone)}`);
  }
  if (status === 'archived' && a.archived_at)
    parts.push(`Archived ${formatDateTime(a.archived_at, timeZone)}`);
  return parts.join(' · ');
}

type Can = (key: string) => boolean;

/** The "New" button (insert RLS requires alerts.create). */
export const canCreate = (can: Can) => can('alerts.create');

/** The Drafts view: managers see all drafts, creators their own. */
export const canSeeDrafts = (can: Can) => can('alerts.create') || can('alerts.manage');

/** Management controls: alerts.manage for any alert; alerts.create for your own. Display only. */
export function canManage(a: AlertLike, viewerId: string | null, can: Can): boolean {
  return can('alerts.manage') || (viewerId !== null && a.created_by === viewerId && can('alerts.create'));
}

/** Severities the editor offers: emergency only with alerts.manage. */
export function severityChoices(can: Can, current?: string): Severity[] {
  if (can('alerts.manage')) return SEVERITIES;
  // Without alerts.manage an existing emergency cannot be changed (it is shown, locked).
  if (current === 'emergency') return ['emergency'];
  return SEVERITIES.filter((s) => s !== 'emergency');
}

/** Whether the severity may change in the editor (the trigger's rule). */
export function canChangeSeverity(a: AlertLike | null, can: Can): boolean {
  if (can('alerts.manage')) return true;
  return !a || (statusOf(a) === 'draft' && a.severity !== 'emergency');
}

export type AlertAction = 'edit' | 'publish' | 'end' | 'cancel' | 'discard' | 'archive';

/** Lifecycle actions from a status (the trigger's transitions). */
export function lifecycleActions(a: AlertLike, can: Can): AlertAction[] {
  switch (statusOf(a)) {
    case 'draft':
      // Publishing an emergency needs alerts.manage.
      return a.severity === 'emergency' && !can('alerts.manage')
        ? ['edit', 'discard']
        : ['edit', 'publish', 'discard'];
    case 'published':
      return ['edit', 'end', 'cancel'];
    case 'cancelled':
    case 'expired':
      return ['archive'];
    default:
      return [];
  }
}

/** Server refusals explained in plain words. */
export function alertError(error: unknown): string {
  if (isServiceError(error)) {
    if (/must be in the future/i.test(error.message)) {
      return 'The end time has passed. Choose a later time or remove it.';
    }
    if (/emergency|severity requires/i.test(error.message)) {
      return 'Only people who manage alerts can issue or change emergency alerts.';
    }
    if (
      /invalid alert transition|cannot be modified|only draft or published|reason can only/i.test(
        error.message,
      )
    ) {
      return 'This alert has changed meanwhile. Go back and open it again.';
    }
    if (error.code === ErrorCode.Forbidden) return "You don't have permission to change this alert.";
    if (error.code === ErrorCode.NotFound) return 'This alert is no longer available.';
  }
  return errorMessage(error);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Editor end time: a date (YYYY-MM-DD) and an optional time (HH:MM, 24 h) on
 * this device; without a time, the end of that day. Must be in the future.
 */
export function parseAlertEnd(
  dateText: string,
  timeText: string,
  now = Date.now(),
): { value: string | null } | { error: string; field: 'date' | 'time' } {
  const date = dateText.trim();
  const time = timeText.trim();
  if (!date) return time ? { error: 'Choose a date for this time.', field: 'date' } : { value: null };
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return { error: 'Use the format YYYY-MM-DD, e.g. 2026-12-31.', field: 'date' };
  const t = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  if (time && !t) return { error: 'Use the format HH:MM, e.g. 18:30.', field: 'time' };
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hours, minutes] = t ? [Number(t[1]), Number(t[2])] : [23, 59];
  if (hours > 23 || minutes > 59) return { error: 'That time does not exist.', field: 'time' };
  const end = new Date(year, month - 1, day, hours, minutes, 0);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) {
    return { error: 'That date does not exist.', field: 'date' };
  }
  if (end.getTime() <= now) return { error: 'Choose a time in the future.', field: t ? 'time' : 'date' };
  return { value: end.toISOString() };
}

/** ISO timestamp → the editor's date and time fields (device time). */
export function formatAlertEnd(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

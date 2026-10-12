// Display rules for announcements. Who may do what is decided by the
// database (RLS + the lifecycle trigger); these helpers only decide which
// controls to show and how to describe an announcement.
import { ErrorCode, isServiceError } from '@communione/services';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';

export interface AnnouncementLike {
  status: string;
  priority: string;
  published_at: string | null;
  expires_at: string | null;
  archived_at?: string | null;
  edited_at: string | null;
  author_user_id: string | null;
}

export const isExpired = (a: Pick<AnnouncementLike, 'expires_at'>, now = Date.now()) =>
  !!a.expires_at && Date.parse(a.expires_at) <= now;

/** One line under the title: publication, edits and expiry. */
export function announcementDates(a: AnnouncementLike, now = Date.now()): string {
  const parts: string[] = [];
  if (a.status === 'draft') parts.push('Draft, not published');
  else if (a.published_at) parts.push(`Published ${formatDate(a.published_at)}`);
  if (a.edited_at && a.status !== 'draft') parts.push('Edited');
  if (a.status === 'archived' && a.archived_at) parts.push(`Archived ${formatDate(a.archived_at)}`);
  if (a.expires_at)
    parts.push(
      isExpired(a, now) ? `Expired ${formatDate(a.expires_at)}` : `Expires ${formatDate(a.expires_at)}`,
    );
  return parts.join(' · ');
}

/** A short status badge, or null for a current published announcement. */
export function statusBadge(a: AnnouncementLike, now = Date.now()): string | null {
  if (a.status === 'draft') return 'Draft';
  if (a.status === 'archived') return 'Archived';
  if (a.status === 'deleted') return 'Deleted';
  if (isExpired(a, now)) return 'Expired';
  return null;
}

/**
 * Whether to show management controls for this announcement: anyone with
 * announcements.manage; the author with announcements.create. Display only.
 */
export function canManage(
  a: AnnouncementLike,
  viewerId: string | null,
  can: (key: string) => boolean,
): boolean {
  return (
    can('announcements.manage') ||
    (viewerId !== null && a.author_user_id === viewerId && can('announcements.create'))
  );
}

/** Lifecycle actions available from a status (the trigger's transitions). */
export function lifecycleActions(
  status: string,
): ('edit' | 'publish' | 'archive' | 'republish' | 'delete')[] {
  switch (status) {
    case 'draft':
      return ['edit', 'publish', 'delete'];
    case 'published':
      return ['edit', 'archive', 'delete'];
    case 'archived':
      return ['republish', 'delete'];
    default:
      return [];
  }
}

/** Server refusals explained in plain words. */
export function announcementError(error: unknown): string {
  if (isServiceError(error)) {
    if (/expires_at must be in the future/i.test(error.message)) {
      return 'The expiry date has passed. Choose a later date or remove it, then publish.';
    }
    if (/invalid announcement transition|cannot be modified|only draft or published/i.test(error.message)) {
      return 'This announcement has changed meanwhile. Go back and open it again.';
    }
    if (error.code === ErrorCode.Forbidden) return "You don't have permission to change this announcement.";
    if (error.code === ErrorCode.NotFound) return 'This announcement is no longer available.';
  }
  return errorMessage(error);
}

/** Editor date (YYYY-MM-DD, the end of that day on this device) ⇄ ISO timestamp. */
export function parseExpiryDate(text: string): { value: string | null } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return { error: 'Use the format YYYY-MM-DD, e.g. 2026-12-31.' };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const end = new Date(year, month - 1, day, 23, 59, 0);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) {
    return { error: 'That date does not exist.' };
  }
  if (end.getTime() <= Date.now()) return { error: 'Choose a date in the future.' };
  return { value: end.toISOString() };
}

export function formatExpiryDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

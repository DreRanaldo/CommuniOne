// Client-side checks for the create-community form (instant feedback). They
// mirror the service layer and the database, which re-check everything; the
// database also verifies the time zone exists.
import { COMMUNITY_TYPES, type CommunityType } from '@communione/services';

export interface CreateCommunityForm {
  name: string;
  description: string;
  type: CommunityType;
  timezone: string;
}

export type CreateCommunityErrors = Partial<Record<keyof CreateCommunityForm, string>>;

const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const length = (value: string) => [...value.trim()].length;

/** True when the runtime's time-zone database knows the zone (no network). */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The device's time zone, as the default for a new community. */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && TIMEZONE.test(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function validateCreateCommunity(form: CreateCommunityForm): CreateCommunityErrors {
  const errors: CreateCommunityErrors = {};
  if (length(form.name) === 0) errors.name = 'Enter a name for your community.';
  else if (length(form.name) > 120) errors.name = 'Use at most 120 characters.';
  if (length(form.description) > 2000) errors.description = 'Use at most 2000 characters.';
  if (!(COMMUNITY_TYPES as readonly string[]).includes(form.type)) errors.type = 'Choose a community type.';
  const zone = form.timezone.trim();
  if (!zone) errors.timezone = 'Enter a time zone.';
  else if (zone.length > 64 || !TIMEZONE.test(zone) || !isKnownTimeZone(zone))
    errors.timezone = 'Enter a time zone such as America/Chicago or Europe/London.';
  return errors;
}

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The community's address (slug) from its name, e.g. "Maple Grove HOA" →
 * "maple-grove-hoa-x7k2". The random suffix keeps addresses unique without
 * asking the user to invent one; the database enforces uniqueness.
 */
export function slugFor(name: string, random: () => number = Math.random): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  const suffix = Array.from(
    { length: 4 },
    () => SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)],
  ).join('');
  return `${base.length >= 2 ? base : 'community'}-${suffix}`;
}

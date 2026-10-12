// Input validation for every service operation.
//
// The service layer validates first, so callers get precise, field-level
// errors without a round trip; the database re-checks everything (RLS,
// grants, CHECK constraints, triggers) and remains the final authority.
// Validators return the cleaned value or throw a VALIDATION ServiceError.

import { ErrorCode, ServiceError } from './errors.ts';

/** Throws a VALIDATION error for a field. */
export const fail = (field: string, message: string): never => {
  throw new ServiceError(ErrorCode.Validation, message, { field });
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(field, `${field} must be a valid id.`);
  return (value as string).toLowerCase();
}

export function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : uuid(value, field);
}

export function uuidList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) fail(field, `${field} must be a list of ids.`);
  const list = value as unknown[];
  if (list.length > max) fail(field, `${field} may contain at most ${max} ids.`);
  return list.map((item, i) => uuid(item, `${field}[${i}]`));
}

export interface TextRules {
  min?: number;
  max: number;
  /** Trim surrounding whitespace before measuring (default true). */
  trim?: boolean;
  pattern?: RegExp;
  patternMessage?: string;
}

/** Strings: type, trimming, length (in code points) and optional pattern. Control characters other than newlines and tabs are rejected. */
export function text(value: unknown, field: string, rules: TextRules): string {
  if (typeof value !== 'string') fail(field, `${field} must be text.`);
  const cleaned = rules.trim === false ? (value as string) : (value as string).trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) fail(field, `${field} contains invalid characters.`);
  const length = [...cleaned].length;
  const min = rules.min ?? 1;
  if (length < min) fail(field, min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (length > rules.max) fail(field, `${field} must be at most ${rules.max} characters.`);
  if (rules.pattern && !rules.pattern.test(cleaned)) fail(field, rules.patternMessage ?? `${field} has an invalid format.`);
  return cleaned;
}

/** Optional text: undefined stays undefined (field not sent), null or blank clears it. */
export function optionalText(value: unknown, field: string, rules: TextRules): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return text(value, field, { ...rules, min: rules.min ?? 1 });
}

export function oneOf<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(field, `${field} must be one of: ${allowed.join(', ')}.`);
  return value as T[number];
}

export function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, `${field} must be a whole number.`);
  if ((value as number) < min || (value as number) > max) fail(field, `${field} must be between ${min} and ${max}.`);
  return value as number;
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, `${field} must be true or false.`);
  return value as boolean;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A timestamp with an explicit time zone (ISO 8601 string or Date). Returns a normalised ISO string. */
export function dateTime(value: unknown, field: string): string {
  let date: Date | undefined;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && ISO_DATETIME.test(value)) date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) fail(field, `${field} must be a date and time with a time zone (ISO 8601).`);
  const year = (date as Date).getUTCFullYear();
  if (year < 2000 || year > 2200) fail(field, `${field} is out of range.`);
  return (date as Date).toISOString();
}

export function optionalDateTime(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return dateTime(value, field);
}

/** https URLs only (avatars, logos). */
export function httpsUrl(value: unknown, field: string): string {
  const url = text(value, field, { max: 2048 });
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { /* handled below */ }
  if (!parsed || parsed.protocol !== 'https:') fail(field, `${field} must be an https:// URL.`);
  return url;
}

export function optionalHttpsUrl(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return httpsUrl(value, field);
}

/**
 * Accepts only the listed keys of a plain object (mass-assignment guard).
 * Unknown keys are an error rather than silently dropped, so a client cannot
 * believe it changed something it is not allowed to change.
 */
export function only<T extends object>(input: unknown, field: string, allowed: readonly (keyof T & string)[]): Partial<T> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(field, `${field} must be an object.`);
  const unknownKeys = Object.keys(input as object).filter((key) => !allowed.includes(key as keyof T & string));
  const unknownKey = unknownKeys[0];
  if (unknownKey !== undefined) fail(unknownKey, `${unknownKey} cannot be set here.`);
  return input as Partial<T>;
}

/** Requires at least one defined value in a patch. */
export function nonEmptyPatch<T extends object>(patch: T, field: string): T {
  const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T;
  if (Object.keys(cleaned).length === 0) fail(field, 'Nothing to update.');
  return cleaned;
}

/** Interval strings accepted by the database, e.g. "7 days", "12 hours". */
export function interval(value: unknown, field: string): string {
  return text(value, field, {
    max: 32,
    pattern: /^\d{1,4} (minute|minutes|hour|hours|day|days)$/,
    patternMessage: `${field} must look like "7 days" or "12 hours".`,
  });
}

/** A plain JSON object no larger than maxBytes when serialised. */
export function jsonObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field, `${field} must be an object.`);
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    fail(field, `${field} must be plain JSON.`);
  }
  if (size > maxBytes) fail(field, `${field} is too large (at most ${maxBytes} bytes).`);
  return value as Record<string, unknown>;
}

/** A short list of allowed values, without duplicates. */
export function enumList<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) fail(field, `${field} must be a non-empty list.`);
  return [...new Set((value as unknown[]).map((item) => oneOf(item, field, allowed)))];
}

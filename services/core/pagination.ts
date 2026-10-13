// Consistent keyset pagination for every list operation.
//
//   const page1 = await services.posts.list({ communityId, limit: 20 });
//   const page2 = await services.posts.list({ communityId, cursor: page1.nextCursor });
//
// A cursor is an opaque, URL-safe string that encodes the sort key of the
// last item. It is validated on the way back in, so a tampered cursor is a
// VALIDATION error and never reaches a query as anything but typed values.
// Lists never return more than MAX_PAGE_SIZE items.

import { ErrorCode, ServiceError } from './errors.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; null when there are no more items. */
  nextCursor: string | null;
}

export interface PageRequest {
  limit?: number;
  cursor?: string | null;
}

export function pageSize(limit: unknown, max = MAX_PAGE_SIZE): number {
  if (limit === undefined || limit === null) return Math.min(DEFAULT_PAGE_SIZE, max);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ServiceError(ErrorCode.Validation, `limit must be between 1 and ${max}.`, { field: 'limit' });
  }
  return limit;
}

type CursorValue = string | number | null;
/**
 * `text` values may be interpolated into PostgREST filters, so they are
 * identifier-like only. `arg` values are only ever passed as RPC arguments
 * (bound parameters), so any short text without control characters is safe.
 */
export type CursorKind = 'timestamp' | 'uuid' | 'int' | 'text' | 'arg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 as PostgREST returns it; no commas, spaces or parentheses can
// get through, so a cursor value can never change a PostgREST filter expression.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const toBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (s: string): string => {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

export function encodeCursor(values: CursorValue[]): string {
  return toBase64Url(JSON.stringify(values));
}

const badCursor = (): never => {
  throw new ServiceError(ErrorCode.Validation, 'The page cursor is not valid.', { field: 'cursor' });
};

const checkValue = (value: unknown, kind: CursorKind): CursorValue => {
  if (value === null) return null;
  switch (kind) {
    case 'timestamp':
      if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) badCursor();
      return value as string;
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) badCursor();
      return value as string;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 1e9) badCursor();
      return value as number;
    case 'text':
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) badCursor();
      return value as string;
    case 'arg':
      if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001F\u007F]/.test(value)) badCursor();
      return value as string;
  }
};

/** Decodes and type-checks a cursor; returns null for "first page". */
export function decodeCursor(cursor: unknown, kinds: readonly CursorKind[]): CursorValue[] | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return badCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    return badCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== kinds.length) return badCursor();
  return parsed.map((value, i) => checkValue(value, kinds[i] as CursorKind));
}

/** Builds a page: a next cursor is returned only when the page is full. */
export function toPage<T>(rows: T[] | null, limit: number, cursorOf: (last: T) => CursorValue[]): Page<T> {
  const items = rows ?? [];
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}

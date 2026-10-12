// Shared plumbing for every domain service: the Supabase client, logging,
// error translation and the authenticated-identity check.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types.ts';
import { ErrorCode, ServiceError, toServiceError, type DbError } from './errors.ts';
import { safeLogger, silentLogger, type Logger } from './logger.ts';

export type Db = SupabaseClient<Database>;

export interface ServiceContext {
  db: Db;
  logger: Logger;
  /**
   * Runs one service operation: translates every failure into a
   * ServiceError and logs it without sensitive data.
   */
  run<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  /**
   * The signed-in user's id, from the Supabase session (never from caller
   * input). This is a fast local check for a clear UNAUTHENTICATED error;
   * the database independently re-validates the session on every request.
   */
  requireUserId(): Promise<string>;
}

/**
 * Called with every failure after it is translated and logged, e.g. so an app
 * can react to UNAUTHENTICATED (an expired or revoked session) in one place.
 */
export type ErrorListener = (error: ServiceError, operation: string) => void;

export function createContext(db: Db, logger: Logger = silentLogger, onError?: ErrorListener): ServiceContext {
  const log = safeLogger(logger);
  return {
    db,
    logger: log,
    async run(operation, fn) {
      try {
        return await fn();
      } catch (thrown) {
        const error = toServiceError(thrown);
        if (error.code === ErrorCode.ServerError) {
          log.log('error', 'service.error', { operation, code: error.code, cause: (error as { cause?: unknown }).cause });
        } else if (error.code === ErrorCode.RateLimited) {
          log.log('warn', 'service.rate_limited', { operation, retryAfterSeconds: error.details.retryAfterSeconds });
        } else {
          log.log('debug', 'service.refused', { operation, code: error.code });
        }
        try {
          onError?.(error, operation);
        } catch {
          // A listener must never change the outcome of an operation.
        }
        throw error;
      }
    },
    async requireUserId() {
      const { data, error } = await db.auth.getSession();
      const id = data.session?.user?.id;
      if (error || !id) throw new ServiceError(ErrorCode.Unauthenticated);
      return id;
    },
  };
}

/** Unwraps a supabase-js result, throwing the translated error. */
export function unwrap<T>(result: { data: T; error: DbError | null }): T {
  if (result.error) throw result.error;
  return result.data;
}

/** Like unwrap, but a missing row is NOT_FOUND (use with .maybeSingle()). */
export function unwrapOne<T>(result: { data: T; error: DbError | null }, what = 'Not found.'): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null || result.data === undefined) throw new ServiceError(ErrorCode.NotFound, what);
  return result.data as NonNullable<T>;
}

/** First row of a set-returning RPC; empty means NOT_FOUND. */
export function firstRow<T>(rows: T[] | null, what = 'Not found.'): T {
  const row = rows?.[0];
  if (row === undefined) throw new ServiceError(ErrorCode.NotFound, what);
  return row;
}

type Rows<T> = PromiseLike<{ data: T[] | null; error: DbError | null }>;

/**
 * Runs an UPDATE / DELETE that must affect exactly one row and returns it.
 *
 * RLS hides rows the caller may not touch, so an empty result is ambiguous.
 * It is resolved without leaking existence across tenants: if the caller
 * cannot even see the row it is NOT_FOUND (exactly as if it did not exist);
 * if they can see it but not change it, FORBIDDEN.
 */
export async function mutateOne<T>(attempt: () => Rows<T>, isVisible: () => Rows<unknown>, what = 'Not found.'): Promise<T> {
  const rows = unwrap(await attempt()) ?? [];
  const first = rows[0];
  if (first !== undefined) return first;
  const visible = unwrap(await isVisible()) ?? [];
  if (visible.length === 0) throw new ServiceError(ErrorCode.NotFound, what);
  throw new ServiceError(ErrorCode.Forbidden);
}

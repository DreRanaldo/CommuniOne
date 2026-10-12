// Authentication, the caller's own profile, private contact details and
// account deletion. Identity always comes from the Supabase session.

import type { AuthError, Session } from '@supabase/supabase-js';
import { ErrorCode, ServiceError } from '../core/errors.ts';
import { unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';
import type { Tables } from '../database.types.ts';

export type Profile = Tables<'profiles'>;

export interface SignUpInput {
  email: string;
  password: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  /** Where the confirmation link returns to; must be an allowed redirect URL. */
  emailRedirectTo?: string;
}

export interface ProfilePatch {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

const email = (value: unknown) => v.text(value, 'email', { max: 320, pattern: EMAIL, patternMessage: 'email is not a valid address.' }).toLowerCase();
// Mirrors the Auth policy (config.toml / dashboard): 8+ chars, letters and digits.
const password = (value: unknown) => v.text(value, 'password', {
  min: 8, max: 72, trim: false, pattern: /^(?=.*[A-Za-z])(?=.*\d)/, patternMessage: 'password must contain letters and digits.',
});

/** Supabase Auth errors are mapped without revealing whether an account exists. */
function fromAuthError(error: AuthError): ServiceError {
  const status = error.status ?? 0;
  if (status === 429 || error.code === 'over_request_rate_limit' || error.code === 'over_email_send_rate_limit') {
    return new ServiceError(ErrorCode.RateLimited, undefined, {}, error);
  }
  if (error.code === 'invalid_credentials' || error.code === 'email_not_confirmed') {
    // One message for wrong password, unknown email and unconfirmed email.
    return new ServiceError(ErrorCode.Unauthenticated, 'Email or password is incorrect, or the email address is not confirmed yet.', {}, error);
  }
  if (error.code === 'weak_password' || error.code === 'validation_failed' || status === 400 || status === 422) {
    return new ServiceError(ErrorCode.Validation, 'The email or password does not meet the requirements.', {}, error);
  }
  if (status === 401 || status === 403) return new ServiceError(ErrorCode.Unauthenticated, undefined, {}, error);
  return new ServiceError(ErrorCode.ServerError, undefined, {}, error);
}

export function authService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Creates an account. No session is issued until the email is confirmed. */
    signUp(input: SignUpInput): Promise<{ userId: string | null; needsEmailConfirmation: boolean }> {
      return ctx.run('auth.signUp', async () => {
        v.only<SignUpInput>(input, 'input', ['email', 'password', 'displayName', 'firstName', 'lastName', 'emailRedirectTo']);
        const data: Record<string, string> = {};
        const displayName = v.optionalText(input.displayName, 'displayName', { max: 100 });
        const firstName = v.optionalText(input.firstName, 'firstName', { max: 100 });
        const lastName = v.optionalText(input.lastName, 'lastName', { max: 100 });
        if (displayName) data.display_name = displayName;
        if (firstName) data.first_name = firstName;
        if (lastName) data.last_name = lastName;
        const redirect = input.emailRedirectTo === undefined
          ? undefined
          : v.text(input.emailRedirectTo, 'emailRedirectTo', { max: 2048, pattern: /^(https:\/\/|communione:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/ });
        const result = await db.auth.signUp({
          email: email(input.email),
          password: password(input.password),
          options: { data, emailRedirectTo: redirect },
        });
        if (result.error) throw fromAuthError(result.error);
        return { userId: result.data.user?.id ?? null, needsEmailConfirmation: result.data.session === null };
      });
    },

    signIn(input: { email: string; password: string }): Promise<Session> {
      return ctx.run('auth.signIn', async () => {
        v.only<{ email: string; password: string }>(input, 'input', ['email', 'password']);
        const result = await db.auth.signInWithPassword({
          email: email(input.email),
          password: v.text(input.password, 'password', { max: 72, trim: false }),
        });
        if (result.error) throw fromAuthError(result.error);
        return result.data.session;
      });
    },

    /** scope 'local' (this device), 'others' or 'global' (every device). */
    signOut(scope: 'local' | 'others' | 'global' = 'local'): Promise<void> {
      return ctx.run('auth.signOut', async () => {
        const { error } = await db.auth.signOut({ scope: v.oneOf(scope, 'scope', ['local', 'others', 'global'] as const) });
        if (error) throw fromAuthError(error);
      });
    },

    requestPasswordReset(input: { email: string; redirectTo?: string }): Promise<void> {
      return ctx.run('auth.requestPasswordReset', async () => {
        v.only<{ email: string; redirectTo?: string }>(input, 'input', ['email', 'redirectTo']);
        const { error } = await db.auth.resetPasswordForEmail(email(input.email), {
          redirectTo: input.redirectTo === undefined ? undefined : v.text(input.redirectTo, 'redirectTo', { max: 2048 }),
        });
        // Do not reveal whether the address has an account.
        if (error && (error.status === 429 || error.code === 'over_email_send_rate_limit')) throw fromAuthError(error);
      });
    },

    getMyProfile(): Promise<Profile> {
      return ctx.run('auth.getMyProfile', async () => {
        const userId = await ctx.requireUserId();
        return unwrapOne(await db.from('profiles').select('*').eq('id', userId).maybeSingle());
      });
    },

    updateMyProfile(patch: ProfilePatch): Promise<Profile> {
      return ctx.run('auth.updateMyProfile', async () => {
        const userId = await ctx.requireUserId();
        v.only<ProfilePatch>(patch, 'patch', ['displayName', 'firstName', 'lastName', 'bio', 'avatarUrl']);
        const row = v.nonEmptyPatch({
          display_name: v.optionalText(patch.displayName, 'displayName', { max: 100 }),
          first_name: v.optionalText(patch.firstName, 'firstName', { max: 100 }),
          last_name: v.optionalText(patch.lastName, 'lastName', { max: 100 }),
          bio: v.optionalText(patch.bio, 'bio', { max: 1000 }),
          avatar_url: v.optionalHttpsUrl(patch.avatarUrl, 'avatarUrl'),
        }, 'patch');
        const rows = unwrap(await db.from('profiles').update(row).eq('id', userId).select('*'));
        const updated = rows?.[0];
        if (!updated) throw new ServiceError(ErrorCode.Forbidden, 'Your account cannot be changed right now.');
        return updated;
      });
    },

    /** The caller's private phone number (visible to nobody else). */
    getMyPhone(): Promise<string | null> {
      return ctx.run('auth.getMyPhone', async () => {
        await ctx.requireUserId();
        const row = unwrap(await db.from('profile_private').select('phone').maybeSingle());
        return row?.phone ?? null;
      });
    },

    setMyPhone(phone: string | null): Promise<void> {
      return ctx.run('auth.setMyPhone', async () => {
        await ctx.requireUserId();
        const value = phone === null ? null : v.text(phone, 'phone', {
          min: 5, max: 32, pattern: /^\+?[0-9 ().-]{5,32}$/, patternMessage: 'phone may contain digits, spaces, + ( ) . and - only.',
        });
        // user_id defaults to the caller in the database; it is never sent.
        unwrap(await db.from('profile_private').upsert({ phone: value }));
      });
    },

    /**
     * Permanently deletes the caller's account (see
     * docs/architecture/account-deletion.md), then signs out locally.
     */
    deleteMyAccount(): Promise<void> {
      return ctx.run('auth.deleteMyAccount', async () => {
        await ctx.requireUserId();
        unwrap(await db.rpc('delete_my_account'));
        await db.auth.signOut({ scope: 'local' });
      });
    },
  };
}

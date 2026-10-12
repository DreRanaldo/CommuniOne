// Authentication, the caller's own profile, private contact details and
// account deletion. Identity always comes from the Supabase session.

import type { AuthError, Session } from '@supabase/supabase-js';
import { ErrorCode, ServiceError, networkError } from '../core/errors.ts';
import { unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import * as v from '../core/validate.ts';
import type { Tables } from '../database.types.ts';

export type Profile = Tables<'profiles'>;

export const AVATAR_BUCKET = 'avatars';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export type AvatarMimeType = ImageMimeType;

/** Account details from Supabase Auth (verified with the server, not read from the device). */
export interface AccountInfo {
  userId: string;
  email: string | null;
  emailConfirmedAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  /** The profile's account status: anything but "active" means access is restricted. */
  status: string;
}

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
const password = (value: unknown, field = 'password') => v.text(value, field, {
  min: 8, max: 72, trim: false, pattern: /^(?=.*[A-Za-z])(?=.*\d)/, patternMessage: 'password must contain letters and digits.',
});

/** Supabase Auth errors are mapped without revealing whether an account exists. */
function fromAuthError(error: AuthError): ServiceError {
  const status = error.status ?? 0;
  if (error.name === 'AuthRetryableFetchError' || status === 0) return networkError(error);
  if (error.code === 'same_password') {
    return new ServiceError(ErrorCode.Validation, 'Choose a password you have not used here before.', { field: 'password' }, error);
  }
  if (error.code === 'reauthentication_needed') {
    return new ServiceError(ErrorCode.Forbidden, 'For your security, sign in again before changing your password.', {}, error);
  }
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

/**
 * Email links handled by the app, by route (custom scheme: host + path;
 * https: path). The confirmation link signs the user in; the recovery link
 * signs them in so they can choose a new password.
 */
export const AUTH_LINK_KINDS = {
  '/auth/callback': 'signedIn',
  '/auth/reset-password': 'recovery',
} as const;

export type AuthLinkKind = (typeof AUTH_LINK_KINDS)[keyof typeof AUTH_LINK_KINDS];

function authLinkRoute(url: URL): string {
  const path = url.protocol === 'https:' || url.protocol === 'http:' ? url.pathname : `/${url.host}${url.pathname}`;
  return path.replace(/\/+$/, '');
}

const LINK_EXPIRED = 'This link is invalid or has expired. Request a new one.';

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
        // An existing address gets the same answer as a new one, so the app
        // never reveals whether someone has an account (the owner can sign in
        // or reset their password).
        if (result.error?.code === 'user_already_exists') return { userId: null, needsEmailConfirmation: true };
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
        // Do not reveal whether the address has an account: only transport
        // failures and rate limits are reported; everything else looks sent.
        if (!error) return;
        const translated = fromAuthError(error);
        if (translated.code === ErrorCode.RateLimited || translated.details.network) throw translated;
      });
    },

    /**
     * Completes an email link opened in the app (sign-up confirmation or
     * password recovery): exchanges its one-time code for a session (PKCE).
     * Returns which kind of link it was; a recovery session must be followed
     * by updatePassword().
     */
    handleAuthRedirect(link: string): Promise<{ kind: AuthLinkKind }> {
      return ctx.run('auth.handleAuthRedirect', async () => {
        let url: URL;
        try {
          url = new URL(v.text(link, 'link', { max: 4096 }));
        } catch {
          throw new ServiceError(ErrorCode.Validation, LINK_EXPIRED, { field: 'link' });
        }
        const kind = AUTH_LINK_KINDS[authLinkRoute(url) as keyof typeof AUTH_LINK_KINDS];
        if (!kind) throw new ServiceError(ErrorCode.Validation, LINK_EXPIRED, { field: 'link' });
        // Auth reports failures (e.g. an expired link) in the query or the fragment.
        const params = new URLSearchParams(url.search);
        for (const [key, value] of new URLSearchParams(url.hash.replace(/^#/, ''))) if (!params.has(key)) params.set(key, value);
        if (params.get('error') || params.get('error_code')) {
          throw new ServiceError(ErrorCode.Validation, LINK_EXPIRED, { field: 'link' });
        }
        const code = params.get('code');
        if (!code || code.length > 512) throw new ServiceError(ErrorCode.Validation, LINK_EXPIRED, { field: 'link' });
        const { error } = await db.auth.exchangeCodeForSession(code);
        if (error) {
          if (error.code === 'pkce_code_verifier_not_found') {
            throw new ServiceError(ErrorCode.Validation, 'Open this link on the device where you requested it.', { field: 'link' }, error);
          }
          const translated = fromAuthError(error);
          if (translated.details.network) throw translated;
          throw new ServiceError(ErrorCode.Validation, LINK_EXPIRED, { field: 'link' }, error);
        }
        return { kind };
      });
    },

    /** Sets a new password for the signed-in user (also completes password recovery). */
    updatePassword(newPassword: string): Promise<void> {
      return ctx.run('auth.updatePassword', async () => {
        await ctx.requireUserId();
        const { error } = await db.auth.updateUser({ password: password(newPassword) });
        if (error) throw fromAuthError(error);
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

    /** Email and account dates from Auth (asks the server), plus the account status. */
    getMyAccount(): Promise<AccountInfo> {
      return ctx.run('auth.getMyAccount', async () => {
        const userId = await ctx.requireUserId();
        const { data, error } = await db.auth.getUser();
        if (error || !data.user) throw error ? fromAuthError(error) : new ServiceError(ErrorCode.Unauthenticated);
        const profile = unwrapOne(await db.from('profiles').select('status').eq('id', userId).maybeSingle());
        return {
          userId: data.user.id,
          email: data.user.email ?? null,
          emailConfirmedAt: data.user.email_confirmed_at ?? null,
          createdAt: data.user.created_at,
          lastSignInAt: data.user.last_sign_in_at ?? null,
          status: profile.status,
        };
      });
    },

    /**
     * Changes the password after re-checking the current one, so an unlocked
     * phone in someone else's hands cannot take over the account.
     */
    changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
      return ctx.run('auth.changePassword', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['currentPassword', 'newPassword']);
        const current = v.text(input.currentPassword, 'currentPassword', { max: 72, trim: false });
        const next = password(input.newPassword, 'newPassword');
        if (next === current) throw new ServiceError(ErrorCode.Validation, 'Choose a different password.', { field: 'newPassword' });
        const { data } = await db.auth.getUser();
        const address = data.user?.email;
        if (!address) throw new ServiceError(ErrorCode.Unauthenticated);
        const check = await db.auth.signInWithPassword({ email: address, password: current });
        if (check.error) {
          const translated = fromAuthError(check.error);
          if (translated.code === ErrorCode.Unauthenticated) {
            throw new ServiceError(ErrorCode.Validation, 'Your current password is incorrect.', { field: 'currentPassword' }, check.error);
          }
          throw translated;
        }
        const { error } = await db.auth.updateUser({ password: next });
        if (error) {
          const translated = fromAuthError(error);
          if (translated.details.field === 'password') translated.details.field = 'newPassword';
          throw translated;
        }
      });
    },

    /**
     * Uploads a new avatar image (JPEG, PNG or WebP, at most 2 MiB) to the
     * caller's own folder in the private avatars bucket, makes it the profile
     * avatar, and removes the previous file. Returns the updated profile.
     */
    uploadMyAvatar(input: { file: UploadBody; mimeType: AvatarMimeType }): Promise<Profile> {
      return ctx.run('auth.uploadMyAvatar', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['file', 'mimeType']);
        const { mimeType, ext } = checkImage(input, AVATAR_MAX_BYTES);
        const previous = unwrapOne(await db.from('profiles').select('avatar_path').eq('id', userId).maybeSingle()).avatar_path;
        const path = `${userId}/${randomId()}.${ext}`;
        const stored = await db.storage.from(AVATAR_BUCKET).upload(path, uploadBody(input.file, mimeType), { contentType: mimeType, upsert: false });
        if (stored.error) throw new ServiceError(ErrorCode.ServerError, 'The image could not be uploaded. Try again.', {}, stored.error);
        const rows = unwrap(await db.from('profiles').update({ avatar_path: path }).eq('id', userId).select('*'));
        const updated = rows?.[0];
        if (!updated) {
          await db.storage.from(AVATAR_BUCKET).remove([path]);
          throw new ServiceError(ErrorCode.Forbidden, 'Your account cannot be changed right now.');
        }
        // Best effort: an unused file is otherwise removed by the purge job.
        if (previous) await db.storage.from(AVATAR_BUCKET).remove([previous]);
        return updated;
      });
    },

    /** Removes the avatar (profile first, then the file). */
    removeMyAvatar(): Promise<Profile> {
      return ctx.run('auth.removeMyAvatar', async () => {
        const userId = await ctx.requireUserId();
        const previous = unwrapOne(await db.from('profiles').select('avatar_path').eq('id', userId).maybeSingle()).avatar_path;
        const rows = unwrap(await db.from('profiles').update({ avatar_path: null, avatar_url: null }).eq('id', userId).select('*'));
        const updated = rows?.[0];
        if (!updated) throw new ServiceError(ErrorCode.Forbidden, 'Your account cannot be changed right now.');
        if (previous) await db.storage.from(AVATAR_BUCKET).remove([previous]);
        return updated;
      });
    },

    /**
     * A displayable URL for a profile's avatar: a short-lived signed URL for
     * an uploaded avatar (only for people allowed to see that profile), the
     * external https avatar_url otherwise, or null.
     */
    avatarUrl(profile: Pick<Profile, 'avatar_path' | 'avatar_url'>, expiresInSeconds = 3600): Promise<string | null> {
      return ctx.run('auth.avatarUrl', async () => {
        await ctx.requireUserId();
        if (profile.avatar_path) {
          const seconds = v.int(expiresInSeconds, 'expiresInSeconds', 60, 86_400);
          const signed = await db.storage.from(AVATAR_BUCKET).createSignedUrl(profile.avatar_path, seconds);
          return signed.error ? null : signed.data.signedUrl;
        }
        return profile.avatar_url ?? null;
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

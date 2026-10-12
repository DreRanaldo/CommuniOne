export const APP_NAME = 'CommuniOne';
export const TAGLINE = 'One Platform. Every Community.';

/** Custom URL scheme (app.config.ts `scheme`) used for deep links. */
export const URL_SCHEME = 'communione';
/**
 * Deep links Supabase Auth returns to from emails. Both must be listed in the
 * project's allowed redirect URLs (docs/deployment/supabase-auth.md).
 */
export const AUTH_CALLBACK_URL = `${URL_SCHEME}://auth/callback`;
export const PASSWORD_RESET_URL = `${URL_SCHEME}://auth/reset-password`;

/** True for the email links above (handled by the auth layer, not by navigation). */
export const isAuthLink = (url: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*\/)?auth\/(callback|reset-password)/i.test(url);

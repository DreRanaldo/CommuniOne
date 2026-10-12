export const APP_NAME = 'CommuniOne';
export const TAGLINE = 'One Platform. Every Community.';

/** Custom URL scheme (app.config.ts `scheme`) used for deep links. */
export const URL_SCHEME = 'communione';
/** Deep link that Supabase Auth returns to (must be an allowed redirect URL). */
export const AUTH_CALLBACK_URL = `${URL_SCHEME}://auth/callback`;

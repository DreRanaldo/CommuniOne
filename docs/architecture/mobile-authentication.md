# Mobile Authentication (RN-02)

How the mobile app (`apps/mobile`) uses the existing Supabase Auth system. There
is no second authentication system: the app calls Supabase Auth through the
shared service layer (`services.auth`), and the database keeps deciding every
permission, membership, role and tenant boundary on every request. Client-side
auth state only chooses which screens to show.

- **Code:** `apps/mobile/src/features/auth/` (AuthProvider, screens,
  validation), `apps/mobile/src/lib/` (client, session storage, links, session
  events), `services/auth/` (operations).
- **Tests:** `apps/mobile/src/features/auth/auth.test.tsx` (23 UI flow tests),
  `tests/services/auth.test.ts` (16 tests against the real local Supabase
  Auth, including email links from Mailpit), `tests/unit/auth.test.ts`.

## Flows

| Flow | Screens | Service operation | Notes |
|---|---|---|---|
| Sign up | Welcome → Create account → "Check your email" | `auth.signUp({ email, password, displayName?, emailRedirectTo: communione://auth/callback })` | No session until the email is confirmed. The answer is the same whether or not the address already has an account. |
| Confirm email | Email link → app opens → signed in | `auth.handleAuthRedirect(url)` → `{ kind: 'signedIn' }` | PKCE: the link carries a one-time code that only works with the verifier stored on the phone that signed up. |
| Sign in | Welcome → Sign in → app | `auth.signIn({ email, password })` | One message for wrong password, unknown address and unconfirmed address. The password field is cleared after a failure. |
| Sign out | Profile → Account & security → Sign out → Welcome | `auth.signOut('local')` | Intentional: no "session expired" notice. |
| Session restoration | Splash → loading state → app or Welcome | `getSession()` (keychain), then `getUser()` | The native splash stays up until the stored session is read. The restored session is then checked with Auth. |
| Forgot password | Sign in → Forgot password → "Check your email" | `auth.requestPasswordReset({ email, redirectTo: communione://auth/reset-password })` | Same confirmation for every address. Network failures and rate limits are reported, so an unsent request is never shown as sent. |
| Reset password | Email link → "Choose a new password" → app | `auth.handleAuthRedirect(url)` → `{ kind: 'recovery' }`, then `auth.updatePassword(pw)` | Recovery mode: the only reachable screen until a new password is saved, or the user cancels (which signs out). |

## Session handling

- **Storage:** the session (access and refresh tokens) is kept in the device
  keychain / keystore (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`,
  chunked), never in plain storage. Passwords are never stored: form state
  only, cleared after use. The OS password manager may offer to save them
  (`textContentType`), which stays in the OS keychain.
- **Refresh:** supabase-js refreshes tokens automatically while the app is in
  the foreground.
- **Restoring:** `restoring` → `signedIn` / `signedOut`. A loading state (and
  the native splash) is shown; no auth or app screen flashes.

### Expired and revoked sessions

A session can end without the user signing out. The AuthProvider detects every
case, signs out locally, and the sign-in screen shows **"Your session has
expired. Please sign in again."**

| Cause | How it is detected |
|---|---|
| Refresh token expired or revoked | supabase-js fails the refresh and emits `SIGNED_OUT` without the user asking |
| Session revoked on the server (signed out on another device, password changed, account suspended or deleted) | `getUser()` at start and on return to the foreground (at most once a minute): Auth answers `403 session_not_found`, and supabase-js clears the session |
| Revoked while the app is in use | Any service call answers `UNAUTHENTICATED` (the database refuses the session: `42501 authentication required`). The service layer's `onError` hook raises a session-expired event, and the app signs out locally |
| Offline | Network errors are **not** treated as expiry: the user stays signed in and sees connection errors instead |

Both revocation behaviours were confirmed against the local Supabase Auth and
are covered by `tests/services/auth.test.ts`.

### Email links (PKCE)

- The client uses `flowType: 'pkce'`. Email links redirect to
  `communione://auth/callback?code=…` (confirmation) or
  `communione://auth/reset-password?code=…` (recovery). Tokens never appear in
  a URL.
- **S256 challenge.** React Native (Hermes) has no WebCrypto, so supabase-js
  would fall back to a `plain` challenge (the verifier itself) and to
  `Math.random()` for the verifier ("WebCrypto API is not supported…").
  `src/lib/webCrypto.ts` installs `crypto.getRandomValues` and
  `crypto.subtle.digest('SHA-256')` backed by the platform's native crypto
  (`expo-crypto`), and `index.ts` loads it first, before the Supabase client
  exists. It only fills what is missing and only offers SHA-256.
  `webCrypto.test.ts` checks that Supabase then sends an S256 challenge with a
  random verifier, and fails without the polyfill.
- Navigation ignores these links (`linking.filter`); the AuthProvider
  completes them with `services.auth.handleAuthRedirect`, which validates the
  route, rejects error links, and exchanges the code.
- Link problems are shown in plain words: "This link is invalid or has
  expired. Request a new one." or "Open this link on the device where you
  requested it." (the code verifier lives only on that phone).
- Both URLs must be in the Auth project's allowed redirect URLs (local:
  `supabase/config.toml`; hosted: see
  [`../deployment/supabase-auth.md`](../deployment/supabase-auth.md)).

## Errors shown to users

| Situation | Message |
|---|---|
| Field problems (before any request) | "Enter a valid email address.", "Use at least 8 characters.", "Use both letters and numbers.", "The passwords do not match." |
| Wrong credentials / unconfirmed / unknown account | "Email or password is incorrect, or the email address is not confirmed yet." |
| No connection | "We couldn't reach CommuniOne. Check your connection and try again." (`ServiceError.details.network`) |
| Too many attempts | The rate-limit message, with "Try again in about N minutes" when known |
| Session ended | "Your session has expired. Please sign in again." |
| Bad link | "That link did not work: This link is invalid or has expired. Request a new one." |

Nothing reveals whether an email address has an account: sign-up, sign-in and
password reset all answer the same way for known and unknown addresses.

## Security notes

- Client auth state is never used for authorization. The database checks the
  session row, the account status, the membership and the permission on every
  request (Stage 2 identity, RLS).
- Only the public anon / publishable key is in the app (RN-01 guards).
- Account enumeration at the API level: the local Auth server answers a repeat
  sign-up for a confirmed address with `422 user_already_exists`. The service
  layer hides this from the app, but a client calling Auth directly could see
  it. On the hosted project, keep **Confirm email** on, and review Auth's
  enumeration settings, rate limits and CAPTCHA (deployment prerequisites).
- Recovery sessions are full sessions (Supabase design). The app holds the user
  on the reset screen; if the app is killed in recovery mode, the user is
  signed in on restart without being forced to change the password (known
  limitation).

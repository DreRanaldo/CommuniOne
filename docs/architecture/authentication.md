# Authentication Architecture

**Status:** Stage 2, implemented and tested against a real local Supabase stack
(Supabase Auth/GoTrue, PostgREST and Postgres 17).

**Decision:** Supabase Auth is the identity provider. Postgres decides, on every
request, whether that identity is still valid. The client's view of "am I
logged in" is never trusted.

## Components

| Concern | Owner |
|---|---|
| Credentials, sign-up, sign-in, email confirmation, password rules, refresh tokens | Supabase Auth (`auth.users`, `auth.sessions`) |
| Verifying the JWT signature and expiry on every Data API request | PostgREST (rejects with HTTP 401) |
| "Is this token's session still alive? Is the account active?" | Postgres: `private.current_session_user_id()` and `private.current_active_user_id()` |
| What the user may do | Postgres RLS and `has_community_permission()` (see `authorization.md`) |
| Public identity (name, avatar, bio, account status) | `public.profiles` (1:1 with `auth.users`) |

## Configuration (`supabase/config.toml`, `[auth]`)

| Setting | Value | Why |
|---|---|---|
| `enable_confirmations` | `true` | No session until the email address is confirmed |
| `minimum_password_length` / `password_requirements` | `8` / `letters_digits` | Basic password strength, enforced by Supabase Auth |
| `jwt_expiry` | `3600` | 1-hour access tokens. Revocation does **not** wait for expiry (see below). |
| `enable_refresh_token_rotation`, `refresh_token_reuse_interval` | `true`, `10` | Refresh tokens are single-use, so a reused (stolen) token revokes the session |
| `enable_anonymous_sign_ins` | `false` | Anonymous users would get the `authenticated` role. The database also rejects them. |
| `secure_password_change`, `double_confirm_changes` | `true` | Password and email changes need recent authentication or confirmation from both addresses |
| `additional_redirect_urls` | `communione://auth/callback`, `http://localhost:3000/auth/callback`, `http://127.0.0.1:3000/auth/callback` | Exact allow-list for the Expo app and the future admin web app |
| `[auth.sms] enable_signup` | `false` | Phone sign-in is not in the MVP |
| External OAuth | not enabled | When added, secrets go through `env(...)` only |

`config.toml` configures the local stack. A hosted project needs the same values
set in the dashboard (Authentication → Settings), or pushed with
`supabase config push`. Session time limits (`[auth.sessions]`) are left
commented out because they need a paid plan on hosted Supabase. The database
already honours `auth.sessions.not_after` if they are turned on.

## Identity in the database

```
JWT (verified by PostgREST)
  │  sub, role, session_id, is_anonymous
  ▼
private.current_session_user_id()
  = auth.uid()  only if
      role claim = 'authenticated'
      is_anonymous is false
      auth.sessions has a row with id = session_id, for that same user,
        whose not_after (if set) is still in the future
  ▼
private.current_active_user_id()
  = current_session_user_id()  only if profiles.status = 'active'
  ▼
has_community_permission(), every RLS policy, create_community(), ...
```

Every authorization check uses `current_active_user_id()`. There is one
exception: a user with a live session can always read their **own** profile, even
while suspended, so the app can explain why access stopped.

Both functions are `SECURITY DEFINER` because clients cannot read `auth.sessions`.
They take no parameters, pin `search_path = ''`, read one row by primary key, and
return only the caller's own id.

### Why check `auth.sessions`?

Supabase access tokens are stateless JWTs. Without this check, a token keeps
working until it expires (up to an hour) even after the user signs out or an
operator revokes the session. Supabase Auth deletes the session row on sign-out,
so checking for it makes revocation take effect **immediately** for all data
access. The cost is one primary-key lookup per authorization check.

## Behaviour reference

| Situation | Result |
|---|---|
| No token / anon key only | `anon` role. No privileges on any table or RPC (`42501`). |
| Missing API key | Rejected by the gateway (`401`) |
| Expired token | Rejected by PostgREST (`401`, `PGRST303`) |
| Tampered or garbage token | Rejected by PostgREST (`401`) |
| Validly signed token whose session doesn't exist (signed out, revoked, forged `session_id`) | Treated as nobody: no rows, RPCs fail with `42501` |
| Session past `not_after` | Treated as nobody |
| Anonymous-user token | Treated as nobody |
| Account `suspended` or `deactivated` | Can read own profile only. No community access. Cannot edit profile or create communities. |
| `signOut()` (default, global) | All of the user's sessions end. Old access and refresh tokens stop working at once. |
| `signOut({ scope: 'others' })` | Other devices are signed out; the current device stays signed in |
| `refreshSession()` | New access token for the same session; the refresh token rotates |

## Profiles

- **1:1 with `auth.users`:** `profiles.id` is the auth user id, with
  `ON DELETE CASCADE`. Deleting the account deletes the profile. Users delete
  their own account with `rpc('delete_my_account')`; see
  [`account-deletion.md`](account-deletion.md).
- **No private contact details:** co-members can read profiles, so the phone
  number lives in `profile_private`, readable only by its owner (see
  [`privacy.md`](privacy.md)).
- **Created by the database, never by the client:** the `on_auth_user_created`
  trigger runs in the same transaction as the sign-up. A user therefore cannot
  exist without a profile, and a test checks this invariant. Clients have no
  INSERT privilege on profiles.
- **No duplicates:** the primary key plus `ON CONFLICT DO NOTHING` in the trigger
  and the backfill. Signing up again with an existing email creates no new user
  or profile.
- **Sign-up metadata is untrusted:** `raw_user_meta_data` is controlled by the
  user, and they can edit it later with `auth.updateUser`. It is only used to
  pre-fill the profile:
  - values are trimmed and truncated to fit the column limits;
  - blank values become NULL;
  - only `https://` avatar URLs are kept;
  - it is copied once at sign-up, and later metadata changes never overwrite the profile;
  - it is **never** used for authorization. Neither is the JWT's `user_metadata`
    claim. Only `app_metadata` is server-controlled.
- **Normalisation:** a trigger trims all text fields and turns blanks into NULL.
  `avatar_url` must be `https://`.

### Who may modify a profile

| Actor | Can edit | How |
|---|---|---|
| The user (live session, active account) | name fields, avatar, bio | Direct `UPDATE` (column grants + RLS) |
| The user (live session, active account) | their phone number | `profile_private` insert / update / delete (owner-only RLS) |
| A platform admin | the same columns on **any** profile | Direct `UPDATE` (RLS) |
| A platform admin | `status` of any **other** account | `rpc('admin_set_account_status', { p_user_id, p_status })` |
| Community Owners and Admins | nothing | Profiles are global identities shared across communities, so community permissions never grant profile edits |
| Anyone | `profiles.status` via `UPDATE` | Never. No client role has the column privilege. |

**Platform admins** are rows in `public.platform_admins`. Clients cannot read or
write that table. Grant or revoke admin rights only server-side:

```sql
insert into public.platform_admins (user_id, granted_by) values ('<user uuid>', '<granter uuid>');
delete from public.platform_admins where user_id = '<user uuid>';
```

Platform-admin rights are lost the moment the admin's own session ends or their
account stops being `active`.

Hosted-project Auth settings (email confirmation, redirect URLs, password
policy, SMTP) are deployment prerequisites, documented in
[`../deployment/supabase-auth.md`](../deployment/supabase-auth.md).

## Client contract (for the mobile and admin apps in later stages)

1. **Use `supabase-js` with the anon or publishable key only.** Never ship the
   service-role or secret key in a client.
2. **Do not trust the local session.** `auth.getSession()` reads local storage
   and does not prove anything. Use `auth.getUser()` (which asks Supabase Auth)
   when the server must know who the user is. For data access, simply call the
   Data API: the database decides.
3. **Handle `onAuthStateChange`:** on `SIGNED_OUT`, clear app state. On
   `TOKEN_REFRESHED`, nothing extra is needed.
4. **Treat these as "signed out"** and send the user back to sign-in:
   - HTTP `401` from the Data API (`PGRST301` invalid JWT, `PGRST303` expired JWT);
   - Auth errors `session_not_found` or `refresh_token_not_found`;
   - `42501` responses for requests that worked a moment earlier (session revoked).
5. **Suspended accounts:** if data suddenly comes back empty, read the user's own
   profile. A `status` of `suspended` or `deactivated` explains why.
6. **Mobile storage:** persist the session in secure storage (e.g. Expo
   SecureStore), not plain AsyncStorage. To be decided in the mobile stage.

## Tests

| Suite | What it proves |
|---|---|
| `supabase/tests/database/009_sessions_and_accounts.test.sql` (pgTAP, 28) | Identity requires a live, non-anonymous, unexpired session and an active account. Logout and suspension take effect immediately. |
| `supabase/tests/database/010_profiles_and_admin.test.sql` (pgTAP, 26) | Profile creation and mapping, no duplicates, normalisation, own-profile edits, community Owners cannot edit profiles, the platform-admin path |
| `tests/integration/signup-and-profiles.test.mjs` (34 total with the next file) | Real email sign-up → profile, email confirmation via Mailpit, duplicate sign-up, weak password, own/other/co-member profile edits, admin suspension |
| `tests/integration/sessions.test.mjs` | Unauthenticated access, expired/tampered/garbage/forged tokens, logout (global and others), refresh-token reuse after logout, token refresh |

Run:

```bash
npm install
npm run db:start          # local Supabase (Docker)
npm run db:reset          # apply migrations to a clean database
npm test                  # pgTAP suite + end-to-end auth suite
scripts/db/test.sh        # pgTAP suite on plain PostgreSQL (no Docker)
```

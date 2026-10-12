# Hosted Supabase: Auth Configuration and Deployment Prerequisites

How the hosted (production and staging) Supabase projects must be configured
for CommuniOne, and which steps must be done by hand in the dashboard.

## Current state (inspected for Pre-Stage 12)

| Item | State |
|---|---|
| Supabase CLI | `supabase` 2.120.0 (pinned devDependency) |
| Local configuration | `supabase/config.toml`: auth settings for the local stack (below) |
| CLI link to a hosted project | **Not linked.** There is no `supabase/.temp/project-ref`, and no `SUPABASE_ACCESS_TOKEN` or project credentials are available to the repository or CI. |
| Consequence | Hosted settings **cannot be inspected or changed from the repository**, and no attempt was made to work around that. Every hosted setting below is a **manual deployment prerequisite**. |
| `.env.example` | Variable **names** only, with placeholders. Real values go in git-ignored `.env.local` files or a secrets manager. |
| `.gitignore` | Ignores `.env`, `.env.*` (except `.env.example`) and `supabase/.temp`. Verified with `git check-ignore`. `scripts/check-secrets.sh` (run in CI) fails if a key, JWT, private key or password-bearing database URL is committed. |

Note: CLI 2.120 can **compare** local and hosted configuration
(`supabase config diff`) and pull hosted values (`supabase config pull`), but it
does not push auth configuration. Use the dashboard.

## Manual deployment prerequisites (do these for every hosted project)

Each row: the setting, the required value, and where to change it in the
Supabase dashboard (project → left sidebar).

### Authentication → Sign In / Providers

| Setting | Required value | Why |
|---|---|---|
| Allow new users to sign up | **On** | Public sign-up (users then join communities through invitations) |
| Email provider | **Enabled** | Email + password is the only sign-in method so far |
| Confirm email | **On** | No access until the address is verified (matches local `enable_confirmations = true`) |
| Secure email change (double confirm) | **On** | Both old and new address must confirm |
| Secure password change | **On** | Recent sign-in required to change the password |
| Allow anonymous sign-ins | **Off** | Anonymous users must never satisfy `authenticated` policies |
| Allow manual linking | **Off** | |
| Phone provider | **Off** | Phone numbers are private profile data, not a login method (see `docs/architecture/privacy.md`) |
| Social providers (Google, Apple) | Off until a stage adds them | Their client secrets must be stored in the dashboard only |

### Authentication → Sign In / Providers → Password settings (or Policies)

| Setting | Required value |
|---|---|
| Minimum password length | **8** (higher is fine) |
| Password requirements | **Letters and digits** (or stronger) |
| Leaked password protection | **On** where the plan allows it |

### Authentication → URL Configuration

| Setting | Required value |
|---|---|
| Site URL | The production web URL (e.g. `https://app.communione.example`); **never** `localhost` in production |
| Redirect URLs | Exactly: `communione://auth/callback` (mobile: email confirmation), `communione://auth/reset-password` (mobile: password recovery) and `https://<admin web domain>/auth/callback`. For staging add the staging domain. No wildcards in production. |

The app passes `emailRedirectTo` / `redirectTo` with one of these URLs; Supabase
rejects any URL not on the list.

### Authentication → Sessions

| Setting | Required value |
|---|---|
| JWT expiry (access token) | **3600 seconds** (or shorter) |
| Refresh token rotation | **On** |
| Refresh token reuse interval | **10 seconds** |
| Time-box / inactivity timeout | Optional; if used, document the values here |

Sign-out, revoked sessions and suspended accounts take effect immediately
regardless of JWT expiry, because the database checks for a live
`auth.sessions` row on every request (see `docs/architecture/authentication.md`).

### Authentication → Emails → SMTP Settings

| Setting | Required value |
|---|---|
| Custom SMTP | **Required for production.** The built-in sender is rate limited and meant for testing. Configure host, port, username, sender address and password **in the dashboard only**. |
| Email templates | Confirm signup, Reset password and Change email must use `{{ .ConfirmationURL }}` so the redirect URL above is honoured. |

### Authentication → Rate Limits

The local stack allows 100 emails per hour (`config.toml`) because the test
suites send many confirmation and reset emails to the local Mailpit. Do not
copy that value: in production start from the provider's limit and adjust to
traffic. Also consider enabling CAPTCHA (Authentication → Attack Protection)
for sign-up and password reset. Emails sent ≈ provider limit,
sign-ups/sign-ins 30 per 5 minutes per IP, token refresh 150 per 5 minutes per
IP, token verifications 30 per 5 minutes per IP.

### Project Settings → Data API

| Setting | Required value |
|---|---|
| Exposed schemas | `public` (and `graphql_public` if GraphQL is used). **Never** `private`, `auth` or `storage`. |
| Max rows | 1000 (default) |

### Project Settings → API Keys

| Key | Where it may be used |
|---|---|
| Project URL | Everywhere (`EXPO_PUBLIC_SUPABASE_URL`) |
| `anon` / publishable key | The mobile and web apps (`EXPO_PUBLIC_SUPABASE_ANON_KEY`). It is designed to be public: every request is still subject to RLS. |
| `service_role` / secret key | **Server only**: Edge Functions and scheduled jobs. **Never** in React Native code, a client bundle, git, a committed `.env` file, or CI. It bypasses RLS. If it is ever exposed, rotate it immediately in this screen. |
| JWT secret / signing keys | Never leave the dashboard. Rotate only with a planned sign-out of all users. |

### Storage

The private `documents` bucket and its policies are created by migration 16.
Confirm after the first deploy that it exists and is **not public**, and that the
global upload limit (Storage → Settings) is at least 50 MiB.

### Scheduled jobs (service role, server side)

| Job | Call | Suggested schedule |
|---|---|---|
| Alert expiry | `select public.expire_due_alerts();` | every minute |
| Invitation housekeeping | `select public.expire_invitations();` | hourly |
| Document purge | `list_document_files_to_purge()` then delete files | daily |
| Audit retention | `select public.purge_audit_logs(interval '730 days');` | monthly |
| Rate-limit counters | `select public.purge_rate_limit_counters();` | hourly |

Use pg_cron (Database → Integrations → Cron) or a scheduled Edge Function.

## Deploying database changes

Done by an operator from a trusted machine, never from CI and never with
committed credentials:

```bash
export SUPABASE_ACCESS_TOKEN=...          # personal access token, not committed
npx supabase link --project-ref <ref>     # prompts for the database password
npx supabase db push --dry-run            # review the pending migrations
npx supabase db push
npx supabase config diff                  # compare hosted auth config with config.toml
```

`supabase/.temp/` (created by `link`) is git-ignored.

## Verification checklist after configuring a hosted project

- [ ] Sign up with a new email: no session until the email link is clicked.
- [ ] The confirmation link opens `communione://auth/callback` (mobile) or the admin callback.
- [ ] Anonymous sign-in is refused.
- [ ] A password like `password` is refused.
- [ ] `select` on `private.*` through the Data API returns "schema not exposed".
- [ ] The `documents` bucket is private.
- [ ] The app bundle contains only the URL and anon key (search the build output for `service_role`).

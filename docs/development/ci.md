# Continuous Integration

- **Workflow:** `.github/workflows/ci.yml` (GitHub Actions)
- **Triggers:** every pull request, and pushes to `main` and `claude/**`
  (so automated branches are verified before a PR is opened). A newer push to
  the same ref cancels the older run.
- **Credentials:** none. CI never connects to a hosted Supabase project. Each
  job builds its own throwaway database from the migrations; the only keys used
  are the local development keys that `supabase start` generates inside the
  runner and that `scripts/test-integration.sh` reads at runtime. No repository
  secrets are read, and the workflow token is `contents: read`.

## Jobs

All three run in parallel; a pull request is green only when all three pass.

| Job | Steps | Local equivalent |
|---|---|---|
| **Lint, typecheck, unit tests and build** | `npm ci` → `npm run lint` (JS syntax, `bash -n`, shellcheck, secret scan) → `npm run typecheck` (strict TypeScript for `services/` and `tests/**/*.ts`; `--checkJs` for scripts and `.mjs` tests) → `npm run test:unit` (service-layer core) → `npm run build` (compiles `services/` to `dist/`) | `npm run lint && npm run typecheck && npm run test:unit && npm run build` |
| **Migrations + pgTAP + concurrency (plain PostgreSQL 16)** | install pgTAP / pg_prove → start a fresh cluster → `scripts/db/test.sh` (create an empty database, apply the Supabase shim and **every migration in order**, run all pgTAP files) → `scripts/db/invitation-race.sh` → `scripts/db/rsvp-stress.sh 16 100` | `npm run test:db:plain && npm run test:db:concurrency` |
| **Supabase stack** | `npm ci` → `npm run db:start` (real Supabase in Docker; applies every migration to a clean database) → `npm run db:reset` (**build verification**: rebuild from scratch) → `npm run db:lint` (plpgsql_check, fails on warnings) → `npm run db:types` + `git diff --exit-code` (generated types match the schema) → `npm run test:db` (pgTAP on real Supabase) → `npm run test:integration` (Auth, Data API, Storage end to end, then every service-layer suite in `tests/services/`) | same commands |

**Build verification:** the build compiles the service layer (`services/`) to
JavaScript with declarations in `dist/` (Stage 12), and the full migration chain
is rebuilt from an empty database twice (plain PostgreSQL and Supabase). There
is no app bundle yet; add the React Native / admin builds to the static job
when those apps exist.

## Secret protection

`scripts/check-secrets.sh` (part of `npm run lint`) fails the build if a tracked
file contains a JWT (Supabase anon / service-role keys are JWTs), a new-style
`sb_secret_` / `sb_publishable_` key, a Supabase access token, a private key, a
database URL with a password, the well-known local JWT secret, or if any `.env`
file other than `.env.example` is tracked.

If a future job genuinely needs a credential (e.g. a staging deploy), store it
as a GitHub Actions **environment secret** on a protected environment, never in
the workflow file, and never run that job for pull requests from forks.

## Running everything locally

```bash
npm ci
npm run lint && npm run typecheck
# plain PostgreSQL 16 + pgTAP (libpq env vars select the server)
npm run test:db:plain && npm run test:db:concurrency
# Supabase stack (Docker)
npm run db:start && npm run db:reset && npm run db:lint
npm test            # pgTAP on Supabase + integration tests
```

## Verified

The first run of this workflow
([run 38181284485](https://github.com/DreRanaldo/CommuniOne/actions/runs/38181284485))
passed all three jobs on commit `075c2d5`.

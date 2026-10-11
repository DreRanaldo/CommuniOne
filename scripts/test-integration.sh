#!/usr/bin/env bash
# Runs the end-to-end auth tests (tests/integration) against the LOCAL
# Supabase stack: real Supabase Auth (GoTrue), PostgREST and Postgres.
#
#   npm run db:start   # once
#   npm run db:reset   # apply migrations to a clean database
#   npm run test:integration
#
# Connection details and the local demo keys are read from
# `supabase status` at runtime; nothing is hard-coded or committed.
# The tests refuse to run against anything other than localhost.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

status_env="$(npx --no-install supabase status -o env 2>/dev/null)" || {
  echo "Local Supabase is not running. Start it with: npm run db:start" >&2
  exit 1
}

get() { printf '%s\n' "${status_env}" | sed -n "s/^$1=\"\(.*\)\"$/\1/p"; }

SUPABASE_URL="$(get API_URL)"
SUPABASE_ANON_KEY="$(get ANON_KEY)"
SUPABASE_SERVICE_ROLE_KEY="$(get SERVICE_ROLE_KEY)"
SUPABASE_JWT_SECRET="$(get JWT_SECRET)"
MAILPIT_URL="$(get MAILPIT_URL)"
export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET MAILPIT_URL

node --test --test-concurrency=1 "${@:-tests/integration/*.test.mjs}"

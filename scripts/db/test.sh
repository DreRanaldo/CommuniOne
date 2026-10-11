#!/usr/bin/env bash
# Rebuilds a throwaway database from scratch, applies every migration in
# order, and runs the pgTAP test suite.
#
# Requirements: psql, pg_prove, PostgreSQL 15+ server with the pgTAP
# extension installed (e.g. `apt-get install postgresql-16-pgtap`).
#
# Connection uses standard libpq env vars (PGHOST, PGPORT, PGUSER,
# PGPASSWORD). The user needs CREATEDB and CREATEROLE (a superuser is
# simplest for a local throwaway server).
#
#   TEST_DB_NAME   database to (re)create          default: communione_test
#   ADMIN_DB_NAME  database used to drop/create it default: postgres
#
# With the Supabase CLI instead:  supabase db reset && supabase test db
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DB_NAME="${TEST_DB_NAME:-communione_test}"
ADMIN_DB_NAME="${ADMIN_DB_NAME:-postgres}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

echo "==> Recreating database ${TEST_DB_NAME}"
"${PSQL[@]}" -d "${ADMIN_DB_NAME}" -c "drop database if exists \"${TEST_DB_NAME}\" with (force)"
"${PSQL[@]}" -d "${ADMIN_DB_NAME}" -c "create database \"${TEST_DB_NAME}\""

echo "==> Applying Supabase compatibility shim"
"${PSQL[@]}" -d "${TEST_DB_NAME}" -f "${ROOT}/scripts/db/supabase_shim.sql"

echo "==> Applying migrations"
for migration in "${ROOT}"/supabase/migrations/*.sql; do
  echo "    $(basename "${migration}")"
  "${PSQL[@]}" -d "${TEST_DB_NAME}" --single-transaction -f "${migration}"
done

echo "==> Running pgTAP tests"
pg_prove -d "${TEST_DB_NAME}" --ext .sql "${ROOT}"/supabase/tests/database/*.test.sql

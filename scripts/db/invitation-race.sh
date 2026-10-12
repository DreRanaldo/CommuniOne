#!/usr/bin/env bash
# Concurrency test for invitation redemption (Pre-Stage 12 / Stage 4).
#
#   1. Deterministic lock test: session A redeems a single-use invitation and
#      holds its transaction open; session B redeems the same token meanwhile.
#      B must wait for A, then be refused cleanly ("expired"/"maximum uses",
#      SQLSTATE 22023). If redemption did not lock the invitation row, B would
#      pass the checks on a stale read and fail later on the use_count CHECK
#      (23514) instead, so this test proves the lock.
#   2. Burst: N clients (distinct users) redeem one invitation with
#      max_uses = LIMIT at the same moment. Exactly LIMIT memberships and
#      redemptions must exist and use_count must equal LIMIT.
#
# Requires: a database built by scripts/db/test.sh (plain PostgreSQL + shim),
# psql and pgbench. Uses libpq env vars; TEST_DB_NAME defaults to
# communione_test. All data it creates is removed afterwards.
#
#   scripts/db/invitation-race.sh [clients=60] [limit=10]
set -euo pipefail

DB="${TEST_DB_NAME:-communione_test}"
CLIENTS="${1:-60}"
LIMIT="${2:-10}"
WORK="$(mktemp -d)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}")
uid() { printf '00000000-0000-4000-9000-%012d' "$1"; }
login_sql() { # $1 = user number
  echo "select set_config('request.jwt.claims', json_build_object('sub', '$(uid "$1")', 'role', 'authenticated', 'session_id', '$(uid "$1")', 'is_anonymous', false)::text, true); set local role authenticated;"
}

cleanup() {
  "${PSQL[@]}" <<SQL || true
begin;
delete from public.invitation_redemptions where community_id = (select id from public.communities where slug = 'invite-race');
delete from public.invitations where community_id = (select id from public.communities where slug = 'invite-race');
delete from public.membership_roles where community_id = (select id from public.communities where slug = 'invite-race');
delete from public.memberships where community_id = (select id from public.communities where slug = 'invite-race');
delete from public.roles where community_id = (select id from public.communities where slug = 'invite-race');
delete from public.communities where slug = 'invite-race';
delete from auth.users where email like 'invrace%@example.test';
commit;
SQL
  [[ -n "${KEEP_WORK:-}" ]] || rm -rf "${WORK}"
}
trap cleanup EXIT

"${PSQL[@]}" <<SQL
begin;
insert into auth.users (id, email)
select ('00000000-0000-4000-9000-' || lpad(i::text, 12, '0'))::uuid, 'invrace' || i || '@example.test'
from generate_series(0, ${CLIENTS} + 2) as i;
insert into auth.sessions (id, user_id)
select id, id from auth.users where email like 'invrace%@example.test';
$(login_sql 0)
select id from public.create_community('Invite race', 'invite-race');
commit;
SQL

new_token() { # $1 = max uses
  "${PSQL[@]}" -At <<SQL
begin;
$(login_sql 0)
select token from public.create_invitation((select id from public.communities where slug = 'invite-race'), interval '1 day', $1);
commit;
SQL
}

# ---------------------------------------------------------------------------
# 1. Deterministic lock test
# ---------------------------------------------------------------------------
echo "==> lock test: a second redemption waits for the first and is refused cleanly"
TOKEN="$(new_token 1 | tail -1)"
"${PSQL[@]}" -At > "${WORK}/a.log" 2>&1 <<SQL &
begin;
$(login_sql 1)
select membership_status from public.redeem_invitation('${TOKEN}');
select pg_sleep(2);
commit;
SQL
A_PID=$!
sleep 0.7
B_OUT="$("${PSQL[@]}" -At 2>&1 <<SQL || true
\set VERBOSITY verbose
begin;
$(login_sql 2)
select membership_status from public.redeem_invitation('${TOKEN}');
commit;
SQL
)"
wait "${A_PID}"
if ! grep -q '^active$' "${WORK}/a.log"; then
  cat "${WORK}/a.log" >&2; echo "FAILED: the first redemption did not succeed" >&2; exit 1
fi
if ! grep -q '22023' <<<"${B_OUT}"; then
  echo "${B_OUT}" >&2; echo "FAILED: the concurrent redemption was not refused with 22023 (row lock missing?)" >&2; exit 1
fi
echo "    first: active; concurrent second: refused (22023)"

# ---------------------------------------------------------------------------
# 2. Burst
# ---------------------------------------------------------------------------
TOKEN="$(new_token "${LIMIT}" | tail -1)"
cat > "${WORK}/burst.sql" <<SQL
\set u :client_id + 3
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', ('00000000-0000-4000-9000-' || lpad(:u::text, 12, '0')), 'role', 'authenticated',
  'session_id', ('00000000-0000-4000-9000-' || lpad(:u::text, 12, '0')), 'is_anonymous', false)::text, true);
set local role authenticated;
select * from public.redeem_invitation('${TOKEN}');
commit;
SQL
echo "==> burst: ${CLIENTS} users redeem one invitation with max_uses ${LIMIT} simultaneously"
pgbench -n -c "${CLIENTS}" -j 8 -t 1 -f "${WORK}/burst.sql" "${DB}" > "${WORK}/burst.log" 2>&1 || true
# Losers are expected to fail with "expired"/"maximum uses"; anything else
# (e.g. a CHECK violation or a deadlock) is a bug.
if grep -E "ERROR:" "${WORK}/burst.log" | grep -vE "maximum number of uses|has expired" | grep -q .; then
  grep -E "ERROR:" "${WORK}/burst.log" | grep -vE "maximum number of uses|has expired" | head -5 >&2
  echo "FAILED: unexpected errors during the burst" >&2
  exit 1
fi
"${PSQL[@]}" -At <<SQL
do \$\$
declare uses int; status text; redemptions int; members int;
begin
  select i.use_count, i.status into uses, status from public.invitations i where i.token_hash = encode(sha256(convert_to('${TOKEN}', 'UTF8')), 'hex');
  select count(*) into redemptions from public.invitation_redemptions r
    join public.invitations i on i.id = r.invitation_id
    where i.token_hash = encode(sha256(convert_to('${TOKEN}', 'UTF8')), 'hex');
  select count(*) into members from public.memberships m
    join public.communities c on c.id = m.community_id
    where c.slug = 'invite-race' and m.status = 'active' and m.user_id not in ('$(uid 0)', '$(uid 1)');
  raise notice 'burst result: use_count=% status=% redemptions=% new members=%', uses, status, redemptions, members;
  if uses <> ${LIMIT} or redemptions <> ${LIMIT} or members <> ${LIMIT} or status <> 'expired' then
    raise exception 'BURST: expected exactly % uses/redemptions/members and status expired', ${LIMIT};
  end if;
end;
\$\$;
SQL
echo "    burst invariants hold"
echo "==> invitation race test passed"

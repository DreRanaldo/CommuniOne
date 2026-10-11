#!/usr/bin/env bash
# Concurrency stress test for event capacity (Stage 8).
#
# Runs many parallel pgbench clients that RSVP, change and cancel RSVPs for
# ONE capacity-limited event as different members, under both READ COMMITTED
# and REPEATABLE READ, then checks the invariants:
#   1. going <= capacity
#   2. if anyone is waitlisted, the event is full (no free place while
#      people wait)
#   3. waitlist positions are consistent (waitlisted <=> waitlisted_at set)
#
# Requires: a database built by scripts/db/test.sh (plain PostgreSQL + shim),
# psql and pgbench. Uses libpq env vars; TEST_DB_NAME defaults to
# communione_test. All data it creates is removed afterwards.
#
#   scripts/db/rsvp-stress.sh [clients=32] [transactions_per_client=200]
set -euo pipefail

DB="${TEST_DB_NAME:-communione_test}"
CLIENTS="${1:-32}"
TX="${2:-200}"
USERS=150
CAPACITY=20
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}")

"${PSQL[@]}" <<SQL
begin;
insert into auth.users (id, email)
select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'stress' || i || '@example.test'
from generate_series(0, ${USERS}) as i;
insert into auth.sessions (id, user_id)
select id, id from auth.users where email like 'stress%@example.test';
-- User 0 creates the community (becomes Owner); the others become Members.
select set_config('request.jwt.claims', json_build_object(
  'sub', '00000000-0000-4000-8000-000000000000', 'role', 'authenticated',
  'session_id', '00000000-0000-4000-8000-000000000000', 'is_anonymous', false)::text, true);
set local role authenticated;
create temp table stress_ids on commit drop as
  select id as community_id from public.create_community('Stress', 'stress-test-community');
reset role;
-- Insert as pending, then admit: admission assigns the default (Member)
-- role, exactly as the real approval flow does.
insert into public.memberships (community_id, user_id, status)
select (select community_id from stress_ids), u.id, 'pending'
from auth.users u where u.email like 'stress%@example.test' and u.id <> '00000000-0000-4000-8000-000000000000';
update public.memberships set status = 'active'
where community_id = (select community_id from stress_ids) and status = 'pending';
insert into public.events (community_id, created_by, title, starts_at, ends_at, capacity, status)
select community_id, '00000000-0000-4000-8000-000000000000', 'Stress event',
       now() + interval '1 day', now() + interval '1 day 1 hour', ${CAPACITY}, 'published'
from stress_ids;
commit;
SQL

EVENT_ID="$("${PSQL[@]}" -At -c "select id from public.events where title = 'Stress event'")"

# Phase 1 (burst): many clients ONLY request 'going' at the same time and
# nobody cancels, so any overbooking would persist and be caught below.
cat > "${WORK}/burst.sql" <<SQL
\set u random(1, ${USERS})
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', ('00000000-0000-4000-8000-' || lpad(:u::text, 12, '0')), 'role', 'authenticated',
  'session_id', ('00000000-0000-4000-8000-' || lpad(:u::text, 12, '0')), 'is_anonymous', false)::text, true);
set local role authenticated;
select * from public.rsvp_to_event('${EVENT_ID}', 'going');
commit;
SQL
BURST_CLIENTS=$(( CLIENTS * 2 ))
echo "==> burst: ${BURST_CLIENTS} clients requesting 'going' simultaneously (capacity ${CAPACITY})"
pgbench -n -d "${DB}" -c "${BURST_CLIENTS}" -j 8 -t 5 --max-tries=20 -f "${WORK}/burst.sql" > "${WORK}/burst.log" 2>&1 || true
grep -E "number of (transactions actually processed|failed transactions)" "${WORK}/burst.log" || true
"${PSQL[@]}" -At <<SQL
do \$\$
declare g int; w int;
begin
  select count(*) filter (where status = 'going'), count(*) filter (where status = 'waitlisted')
    into g, w from public.event_rsvps where event_id = '${EVENT_ID}';
  raise notice 'burst result: going=% waitlisted=%', g, w;
  if g <> ${CAPACITY} then raise exception 'BURST: expected exactly % going, got % (waitlisted %)', ${CAPACITY}, g, w; end if;
  if w = 0 then raise exception 'BURST: expected a waitlist, got none (test did not exceed capacity)'; end if;
end;
\$\$;
SQL
echo "    burst invariants hold"

for ISOLATION in "read committed" "repeatable read"; do
  cat > "${WORK}/rsvp.sql" <<SQL
\set u random(1, ${USERS})
\set action random(1, 10)
begin isolation level ${ISOLATION};
select set_config('request.jwt.claims', json_build_object(
  'sub', ('00000000-0000-4000-8000-' || lpad(:u::text, 12, '0')), 'role', 'authenticated',
  'session_id', ('00000000-0000-4000-8000-' || lpad(:u::text, 12, '0')), 'is_anonymous', false)::text, true);
set local role authenticated;
\if :action <= 6
select * from public.rsvp_to_event('${EVENT_ID}', 'going');
\elif :action <= 8
select * from public.rsvp_to_event('${EVENT_ID}', 'maybe');
\else
select public.cancel_rsvp('${EVENT_ID}');
\endif
commit;
SQL
  echo "==> pgbench: ${CLIENTS} clients x ${TX} transactions, ${ISOLATION}"
  # --max-tries retries serialization failures (expected under REPEATABLE READ).
  pgbench -n -d "${DB}" -c "${CLIENTS}" -j 4 -t "${TX}" --max-tries=20 -f "${WORK}/rsvp.sql" > "${WORK}/pgbench.log" 2>&1 || true
  grep -E "number of (transactions actually processed|failed transactions|transactions retried)" "${WORK}/pgbench.log" || true
  # READ COMMITTED (what the Data API uses): every transaction must complete.
  # REPEATABLE READ: one hot event row makes serialization failures the
  # designed outcome (instead of overbooking); allow those, but nothing else.
  # Either way the invariants below must hold on a non-empty result.
  if [[ "${ISOLATION}" == "read committed" ]]; then
    if ! grep -q "number of transactions actually processed: $((CLIENTS * TX))/$((CLIENTS * TX))" "${WORK}/pgbench.log"; then
      grep -m5 -iE "error|abort" "${WORK}/pgbench.log" >&2 || true
      echo "FAILED: not every pgbench transaction completed" >&2
      exit 1
    fi
  elif grep -iE "error" "${WORK}/pgbench.log" | grep -viE "could not serialize|serialization" | grep -q .; then
    grep -iE "error" "${WORK}/pgbench.log" | grep -viE "could not serialize|serialization" | head -5 >&2
    echo "FAILED: non-serialization errors under repeatable read" >&2
    exit 1
  fi

  "${PSQL[@]}" -At <<SQL
select format('    going=%s waitlisted=%s maybe=%s capacity=%s', going, waitlisted, maybe, ${CAPACITY})
from (select count(*) filter (where status = 'going') going,
             count(*) filter (where status = 'waitlisted') waitlisted,
             count(*) filter (where status = 'maybe') maybe
      from public.event_rsvps where event_id = '${EVENT_ID}') s;
do \$\$
declare g int; w int; bad int;
begin
  select count(*) filter (where status = 'going'), count(*) filter (where status = 'waitlisted')
    into g, w from public.event_rsvps where event_id = '${EVENT_ID}';
  select count(*) into bad from public.event_rsvps
    where event_id = '${EVENT_ID}' and (status = 'waitlisted') <> (waitlisted_at is not null);
  if g = 0 then raise exception 'NO RSVPS RECORDED: the run did not exercise the event'; end if;
  if g > ${CAPACITY} then raise exception 'OVERBOOKED: % going > capacity %', g, ${CAPACITY}; end if;
  if w > 0 and g < ${CAPACITY} then raise exception 'FREE PLACE WHILE WAITING: % going, % waitlisted', g, w; end if;
  if bad > 0 then raise exception 'INCONSISTENT WAITLIST ROWS: %', bad; end if;
end;
\$\$;
SQL
  echo "    invariants hold"
done

"${PSQL[@]}" <<SQL
begin;
delete from public.event_rsvps where event_id = '${EVENT_ID}';
delete from public.events where id = '${EVENT_ID}';
delete from public.membership_roles where community_id = (select id from public.communities where slug = 'stress-test-community');
delete from public.memberships where community_id = (select id from public.communities where slug = 'stress-test-community');
delete from public.roles where community_id = (select id from public.communities where slug = 'stress-test-community');
delete from public.communities where slug = 'stress-test-community';
delete from auth.users where email like 'stress%@example.test';
commit;
SQL
echo "==> RSVP stress test passed"

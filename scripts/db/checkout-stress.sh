#!/usr/bin/env bash
# Concurrency stress test for marketplace checkout and payment (Stage M).
#
# Phase 1: many parallel pgbench clients, as different buyers, put the same
# product in their cart and place an order at the same time. Only STOCK
# units exist, so most must be refused ("only N available" / insufficient
# stock). Invariants:
#   1. held reservations never exceed the stock (no overselling)
#   2. inventory.reserved equals the sum of held reservations
#   3. every placed checkout has exactly one held reservation
# Phase 2: every placed checkout is paid at the same time (as the webhook
# would, in parallel sessions). Invariants:
#   4. on_hand dropped by exactly the number of paid units, reserved is 0
#   5. every order is paid, every checkout is paid
#   6. the ledger balances
#
# Requires a database built by scripts/db/test.sh (plain PostgreSQL + shim),
# psql, pgbench and xargs. TEST_DB_NAME defaults to communione_test. The
# community it creates is left in place only if the test fails.
#
#   scripts/db/checkout-stress.sh [clients=32]
set -euo pipefail

DB="${TEST_DB_NAME:-communione_test}"
CLIENTS="${1:-32}"
USERS=120
STOCK=25
PRICE=100000
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}")
uid() { printf '00000000-0000-4000-9000-%012d' "$1"; }

if [[ "$("${PSQL[@]}" -At -c "select count(*) from public.communities where slug = 'checkout-stress-community'")" != "0" ]]; then
  echo "This database already ran the checkout stress test (its financial rows are append-only)." >&2
  echo "Rebuild it with: bash scripts/db/test.sh" >&2
  exit 1
fi

"${PSQL[@]}" <<SQL
begin;
insert into auth.users (id, email)
select ('00000000-0000-4000-9000-' || lpad(i::text, 12, '0'))::uuid, 'cstress' || i || '@example.test'
from generate_series(0, ${USERS}) as i;
insert into auth.sessions (id, user_id) select id, id from auth.users where email like 'cstress%@example.test';
select set_config('request.jwt.claims', json_build_object(
  'sub', '$(uid 0)', 'role', 'authenticated', 'session_id', '$(uid 0)', 'is_anonymous', false)::text, true);
set local role authenticated;
create temp table cs on commit drop as select id as community_id from public.create_community('Checkout stress', 'checkout-stress-community');
reset role;
insert into public.memberships (community_id, user_id, status)
select (select community_id from cs), u.id, 'pending'
from auth.users u where u.email like 'cstress%@example.test' and u.id <> '$(uid 0)';
update public.memberships set status = 'active' where community_id = (select community_id from cs) and status = 'pending';
-- The owner (user 0) sells one product with ${STOCK} units.
insert into public.seller_profiles (id, community_id, user_id, display_name)
values ('5e000000-0000-4000-9000-000000000001', (select community_id from cs), '$(uid 0)', 'Stress Shop');
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, condition, price_minor, fulfillment, status)
values ('1a000000-0000-4000-9000-000000000001', (select community_id from cs), '5e000000-0000-4000-9000-000000000001', '$(uid 0)', 'product',
        (select id from public.market_categories where kind = 'product' order by slug limit 1), 'Last units', 'new', ${PRICE}, '{pickup}', 'active');
update public.inventory set on_hand = ${STOCK} where listing_id = '1a000000-0000-4000-9000-000000000001';
commit;
SQL
COMMUNITY="$("${PSQL[@]}" -At -c "select id from public.communities where slug = 'checkout-stress-community'")"
LISTING='1a000000-0000-4000-9000-000000000001'

cat > "${WORK}/buy.sql" <<SQL
\set u random(1, ${USERS})
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', ('00000000-0000-4000-9000-' || lpad(:u::text, 12, '0')), 'role', 'authenticated',
  'session_id', ('00000000-0000-4000-9000-' || lpad(:u::text, 12, '0')), 'is_anonymous', false)::text, true);
set local role authenticated;
do \$\$
begin
  perform public.cart_set_item('${LISTING}', 1);
  perform public.checkout_create('${COMMUNITY}', gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-9000-000000000001', 'method', 'pickup')),
    null, 'Stress Buyer', '876 555 0101', ${PRICE}, 'v1');
exception
  -- Refused because stock ran out, or the buyer already holds one: expected.
  when sqlstate '22023' then null;
end;
\$\$;
commit;
SQL
echo "==> phase 1: ${CLIENTS} clients x 10 orders for ${STOCK} units"
pgbench -n -c "${CLIENTS}" -j 8 -t 10 --max-tries=20 -f "${WORK}/buy.sql" "${DB}" > "${WORK}/buy.log" 2>&1 || true
if ! grep -q "number of transactions actually processed: $((CLIENTS * 10))/$((CLIENTS * 10))" "${WORK}/buy.log"; then
  grep -m5 -iE "error|abort" "${WORK}/buy.log" >&2 || true
  echo "FAILED: unexpected errors while ordering" >&2
  exit 1
fi
"${PSQL[@]}" -At <<SQL
do \$\$
declare held int; reserved int; placed int; bad int;
begin
  select coalesce(sum(quantity), 0) into held from public.inventory_reservations where listing_id = '${LISTING}' and status = 'held';
  select i.reserved into reserved from public.inventory i where i.listing_id = '${LISTING}';
  select count(*) into placed from public.checkouts where community_id = '${COMMUNITY}' and status = 'awaiting_payment';
  select count(*) into bad from public.checkouts c where c.community_id = '${COMMUNITY}'
    and (select count(*) from public.inventory_reservations r where r.checkout_id = c.id and r.status = 'held') <> 1;
  raise notice 'phase 1: % checkouts placed, % units held, inventory.reserved %', placed, held, reserved;
  if held > ${STOCK} then raise exception 'OVERSOLD: % held > % in stock', held, ${STOCK}; end if;
  if held <> ${STOCK} then raise exception 'EXPECTED THE STOCK TO SELL OUT: % held of %', held, ${STOCK}; end if;
  if reserved <> held then raise exception 'RESERVED COUNTER DRIFT: inventory % vs reservations %', reserved, held; end if;
  if bad > 0 then raise exception 'CHECKOUTS WITHOUT EXACTLY ONE RESERVATION: %', bad; end if;
end;
\$\$;
SQL
echo "    phase 1 invariants hold"

echo "==> phase 2: paying every checkout in parallel"
"${PSQL[@]}" -At -c "select id || ' ' || buyer_user_id from public.checkouts where community_id = '${COMMUNITY}' and status = 'awaiting_payment'" > "${WORK}/checkouts"
# shellcheck disable=SC2016
xargs -P 16 -L 1 sh -c '
  psql -X -q -v ON_ERROR_STOP=1 -d "$0" -At <<SQL >/dev/null
set role service_role;
select public.payment_attach_session(p.payment_id, '"'"'cs_'"'"' || p.payment_id, '"'"'https://pay.example/'"'"', now() + interval '"'"'15 minutes'"'"')
from public.payment_begin('"'"'$2'"'"', '"'"'$1'"'"', '"'"'test'"'"', '"'"'test'"'"') p;
select public.payment_apply_event('"'"'test'"'"', '"'"'ev_'"'"' || p.id, p.provider_reference, '"'"'succeeded'"'"', p.amount_minor, '"'"'JMD'"'"', now(), null, '"'"'webhook'"'"')
from public.payments p where p.checkout_id = '"'"'$1'"'"';
SQL
' "${DB}" < "${WORK}/checkouts"
"${PSQL[@]}" -At <<SQL
do \$\$
declare on_hand int; reserved int; paid int; unpaid_orders int; total bigint;
begin
  select i.on_hand, i.reserved into on_hand, reserved from public.inventory i where i.listing_id = '${LISTING}';
  select count(*) into paid from public.checkouts where community_id = '${COMMUNITY}' and status = 'paid';
  select count(*) into unpaid_orders from public.orders where community_id = '${COMMUNITY}' and status <> 'paid';
  select coalesce(sum(e.amount_minor), 0) into total from public.ledger_entries e
    join public.ledger_transactions t on t.id = e.transaction_id where t.community_id = '${COMMUNITY}';
  raise notice 'phase 2: % paid, on_hand %, reserved %', paid, on_hand, reserved;
  if paid <> ${STOCK} then raise exception 'EXPECTED % PAID CHECKOUTS, GOT %', ${STOCK}, paid; end if;
  if on_hand <> 0 or reserved <> 0 then raise exception 'STOCK MISCOUNTED: on_hand % reserved %', on_hand, reserved; end if;
  if unpaid_orders > 0 then raise exception '% ORDERS NOT PAID', unpaid_orders; end if;
  if total <> 0 then raise exception 'LEDGER DOES NOT BALANCE: %', total; end if;
end;
\$\$;
SQL
echo "    phase 2 invariants hold"
echo "==> checkout stress test passed (financial rows are append-only; the test community is left in place)"

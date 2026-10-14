-- Marketplace Stage M: security sweep over every commerce table and function (RLS, grants, service-only functions, definer search_path, append-only history, money invariants).
begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixture (identical in every behavioural test file)
--
--   Community A (community-a)            Community B (community-b)
--     alice  Owner  (creator)              bob    Owner  (creator)
--     erin   Admin                         frank  Member
--     dave   Moderator                     alice  Member  <- multi-community
--     carol  Member
--     grace  pending, no role
--
-- Communities are created through public.create_community() as the real
-- users. Other memberships are inserted as a trusted backend would (the
-- Stage 2 invitation / join flows), because clients cannot insert them.
-- ---------------------------------------------------------------------------
-- Impersonates a signed-in user exactly as PostgREST does: role
-- `authenticated` plus verified JWT claims. Every fixture user has a live
-- auth.sessions row whose id equals the user id (see below).
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_user, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create temp table fx (key text primary key, id uuid not null);
grant all on fx to public;

create function pg_temp.fx(p_key text) returns uuid language sql stable as $$
  select id from fx where key = p_key
$$;

create function pg_temp.role_id(p_community text, p_role text) returns uuid language sql stable as $$
  select r.id from public.roles r where r.community_id = pg_temp.fx(p_community) and r.name = p_role
$$;

create function pg_temp.add_member(p_community text, p_user text, p_role text, p_status text default 'active')
returns void language plpgsql as $$
declare v_membership_id uuid;
begin
  insert into public.memberships (community_id, user_id, status)
  values (pg_temp.fx(p_community), pg_temp.fx(p_user), p_status)
  returning id into v_membership_id;
  insert into fx values (p_user || '@' || p_community, v_membership_id);
  if p_role is not null then
    insert into public.membership_roles (membership_id, role_id)
    values (v_membership_id, pg_temp.role_id(p_community, p_role));
  end if;
end;
$$;

insert into fx values
  ('alice', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('bob',   'bbbbbbbb-0000-4000-8000-000000000002'),
  ('carol', 'cccccccc-0000-4000-8000-000000000003'),
  ('dave',  'dddddddd-0000-4000-8000-000000000004'),
  ('erin',  'eeeeeeee-0000-4000-8000-000000000005'),
  ('frank', 'ffffffff-0000-4000-8000-000000000006'),
  ('grace', '99999999-0000-4000-8000-000000000007');

insert into auth.users (id, email)
select id, key || '@example.test' from fx;
insert into auth.sessions (id, user_id)
select id, id from fx;

select pg_temp.login(pg_temp.fx('alice'));
insert into fx select 'A', id from public.create_community('Community A', 'community-a', 'residential');
select pg_temp.login(pg_temp.fx('bob'));
insert into fx select 'B', id from public.create_community('Community B', 'community-b', 'church');
reset role;

insert into fx select 'alice@A', id from public.memberships where community_id = pg_temp.fx('A') and user_id = pg_temp.fx('alice');
insert into fx select 'bob@B',   id from public.memberships where community_id = pg_temp.fx('B') and user_id = pg_temp.fx('bob');

select pg_temp.add_member('A', 'erin',  'Admin');
select pg_temp.add_member('A', 'dave',  'Moderator');
select pg_temp.add_member('A', 'carol', 'Member');
select pg_temp.add_member('A', 'grace', null, 'pending');
select pg_temp.add_member('B', 'frank', 'Member');
select pg_temp.add_member('B', 'alice', 'Member');
-- ---------------------------------------------------------------------------

-- Every marketplace and commerce object, checked together. New tables and
-- functions added later fall under the same rules automatically.
create temp table mk_tables as
select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname = any (array[
  'market_categories', 'seller_profiles', 'listings', 'listing_images', 'inventory', 'inventory_movements', 'favorites',
  'carts', 'cart_items', 'addresses', 'delivery_options', 'tax_rates', 'checkouts', 'orders', 'order_items', 'order_events',
  'inventory_reservations', 'payments', 'payment_events', 'webhook_events', 'refunds', 'refund_items', 'refund_events',
  'ledger_accounts', 'ledger_transactions', 'ledger_entries', 'test_provider_sessions', 'order_shipments', 'order_pickup_codes',
  'refund_policies', 'disputes', 'dispute_messages', 'service_availability', 'service_time_off', 'bookings', 'booking_events',
  'payouts']);
grant select on mk_tables to public;

-- Functions only the payment Edge Functions / operators may call.
create temp table service_only(name text);
insert into service_only values ('payment_begin'), ('payment_begin_booking'), ('payment_attach_session'), ('payment_apply_event'),
  ('payments_to_reconcile'), ('expire_checkouts'), ('expire_unaccepted_orders'), ('complete_delivered_orders'),
  ('refunds_claim'), ('refund_apply_result'), ('refund_retry'), ('expire_unpaid_bookings'), ('complete_past_bookings'),
  ('payout_record'), ('ledger_summary');
grant select on service_only to public;

select is((select count(*)::int from mk_tables), 37, 'every marketplace table is in the sweep');
select is_empty($$ select name from mk_tables t join pg_class c on c.relname = t.name join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and not c.relrowsecurity $$, 'RLS is enabled on every marketplace table');
select is_empty($$ select name, privilege_type from mk_tables t join information_schema.role_table_grants g
                   on g.table_schema = 'public' and g.table_name = t.name where g.grantee in ('anon', 'PUBLIC') $$,
  'anon and PUBLIC hold no table privileges');
select is_empty($$ select t.name, g.privilege_type from mk_tables t join information_schema.role_table_grants g
                   on g.table_schema = 'public' and g.table_name = t.name
                   where g.grantee = 'authenticated' and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
                     and t.name not in ('listings', 'seller_profiles', 'listing_images', 'favorites', 'addresses', 'delivery_options') $$,
  'clients cannot update or delete any order, payment, refund, ledger, booking or dispute row');
select is_empty($$ select t.name from mk_tables t join information_schema.role_table_grants g
                   on g.table_schema = 'public' and g.table_name = t.name
                   where g.grantee = 'authenticated' and g.privilege_type = 'INSERT'
                     and t.name not in ('listings', 'seller_profiles', 'listing_images', 'favorites', 'addresses', 'delivery_options') $$,
  'clients insert only catalog, favorites and address-book rows; everything else goes through checked functions');
select is_empty($$ select t.name from mk_tables t
                   where t.name in ('payment_events', 'webhook_events', 'ledger_accounts', 'ledger_transactions', 'ledger_entries', 'test_provider_sessions')
                     and has_table_privilege('authenticated', 'public.' || t.name, 'select') $$,
  'payment events, webhook events, the ledger and test-provider state are unreadable by clients');
select ok(not has_column_privilege('authenticated', 'public.payments', 'provider_reference', 'select')
          and not has_column_privilege('authenticated', 'public.payments', 'redirect_url', 'select'),
  'clients never read provider references or session links');
select ok(not has_column_privilege('authenticated', 'public.order_pickup_codes', 'failed_attempts', 'select'),
  'pickup-code attempt counters are server-only');

select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   join service_only s on s.name = p.proname
                   where n.nspname = 'public' and (has_function_privilege('authenticated', p.oid, 'execute')
                                                  or has_function_privilege('anon', p.oid, 'execute')) $$,
  'service-only payment, refund, payout and job functions cannot be called by clients');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   join service_only s on s.name = p.proname
                   where n.nspname = 'public' and not has_function_privilege('service_role', p.oid, 'execute') $$,
  'the Edge Functions (service role) can call them');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prosecdef
                     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') $$,
  'every security definer function pins its search_path');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
                     and (p.proname like 'order%' or p.proname like 'refund%' or p.proname like 'dispute%' or p.proname like 'booking%'
                          or p.proname like 'payment%' or p.proname like 'checkout%' or p.proname like 'cart%' or p.proname like 'seller%'
                          or p.proname like 'payout%' or p.proname like 'service_%') $$,
  'signed-out users cannot call any commerce function');
select is_empty($$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and (p.proname like '%refund%' or p.proname like '%ledger%' or p.proname like 'settle%'
                                                   or p.proname like '%order%' or p.proname like '%booking%')
                     and has_function_privilege('authenticated', p.oid, 'execute')
                     and p.proname not in ('can_view_order') $$,
  'private money helpers (ledger, refunds, settlement) are not callable by clients');

-- Append-only financial history.
select is_empty($$ select t from unnest(array['ledger_entries', 'ledger_transactions', 'payment_events', 'refund_events',
                   'order_events', 'order_items', 'booking_events', 'payouts', 'dispute_messages', 'inventory_movements']) t
                   where not exists (select 1 from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
                                     where c.relname = t and tr.tgfoid = 'private.forbid_change'::regproc) $$,
  'financial and history tables are append-only (forbid_change trigger)');
select ok(exists (select 1 from pg_constraint where conname = 'bookings_no_double_booking' and contype = 'x'),
  'double booking is prevented by an exclusion constraint');
select ok(exists (select 1 from pg_trigger where tgname = 'ledger_entries_balanced'), 'ledger transactions must balance');
select ok(exists (select 1 from pg_indexes where indexname = 'payments_one_success_per_checkout')
          and exists (select 1 from pg_indexes where indexname = 'payments_one_success_per_booking'),
  'one successful payment per checkout and per booking');
select ok(exists (select 1 from pg_constraint where conname = 'webhook_events_provider_event_key'),
  'each provider event is processed once');

select * from finish();
rollback;

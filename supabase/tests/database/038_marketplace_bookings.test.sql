-- Marketplace Stage J (migration 38): service hours, booking requests, server-fixed prices, no double booking (exclusion constraint), booking payments, cancellation refunds, jobs, isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

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

-- Booking fixture (trusted setup): carol offers an hourly service in A.
insert into public.seller_profiles (id, community_id, user_id, display_name) values
  ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), pg_temp.fx('carol'), 'Carol Services');
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, pricing, price_minor, status) values
  ('1a000000-0000-4000-8000-000000000001', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'service',
   (select id from public.market_categories where kind = 'service' order by slug limit 1), 'Tutoring', 'hourly', 300000, 'active');
create function pg_temp.t(p_days int, p_utc_hour int) returns timestamptz language sql as $$
  select date_trunc('day', now() at time zone 'utc') at time zone 'utc' + make_interval(days => p_days, hours => p_utc_hour) $$;
create function pg_temp.bk(p_note text) returns uuid language sql security definer as $$ select id from public.bookings where buyer_note = p_note $$;
create function pg_temp.bstatus(p_note text) returns text language sql security definer as $$ select status from public.bookings where buyer_note = p_note $$;

-- =========================================================================
-- 1. Hours and requests
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.service_availability_save('5e000000-0000-4000-8000-000000000001', '[]') $$, 'P0002', null,
  '1. only the shop owner sets its hours');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select public.service_availability_save('5e000000-0000-4000-8000-000000000001', '[{"weekday": 1, "start": "17:00", "end": "09:00"}]') $$,
  '22023', null, '1. a window ends after it starts');
select lives_ok($$ select public.service_availability_save('5e000000-0000-4000-8000-000000000001',
  (select jsonb_agg(jsonb_build_object('weekday', d, 'start', '09:00', 'end', '17:00')) from generate_series(0, 6) d)) $$,
  '1. 09:00-17:00 local, every day');
select throws_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 15), pg_temp.t(3, 16), 'own') $$,
  '22023', 'you cannot book your own service', '1. not your own service');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 12), pg_temp.t(3, 13), 'early') $$,
  '22023', 'the seller is not available at that time', '1. 07:00 local is outside the hours');
select throws_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', now() + interval '10 minutes', now() + interval '70 minutes', 'soon') $$,
  '22023', 'bookings start at least an hour from now', '1. not at the last minute');
select throws_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 15), pg_temp.t(3, 15) + interval '5 minutes', 'tiny') $$,
  '22023', 'a booking lasts from 15 minutes to 12 hours', '1. a sensible length');
select lives_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 15), pg_temp.t(3, 17), 'b1') $$,
  '1. 10:00-12:00 local');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 16), pg_temp.t(3, 18), 'b2') $$,
  '1. an overlapping request is allowed while nothing is accepted');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok($$ select public.booking_request('1a000000-0000-4000-8000-000000000001', pg_temp.t(3, 19), pg_temp.t(3, 20), 'other') $$,
  'P0002', null, '1. another community cannot book');
select is_empty($$ select 1 from public.bookings $$, '1. nor see bookings');

-- =========================================================================
-- 2. Accepting: the server's price; never double-booked
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.booking_accept(pg_temp.bk('b1')) $$, 'P0002', null, '2. the buyer cannot accept');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok($$ select public.booking_accept(pg_temp.bk('b1'), 1) $$, '2. the seller accepts');
select is((select amount_minor from public.bookings where id = pg_temp.bk('b1')), 600000::bigint, '2. 2 hours x J$3,000, whatever price is sent');
select throws_ok($$ select public.booking_accept(pg_temp.bk('b2')) $$, '22023', 'you already have a booking at that time', '2. no double booking');
reset role;
select throws_ok($$ update public.bookings set status = 'accepted', amount_minor = 1 where id = pg_temp.bk('b2') $$, '23P01', null,
  '2. the exclusion constraint holds even for trusted code');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ update public.bookings set amount_minor = 1 $$, '42501', null, '2. buyers cannot change a booking');

-- =========================================================================
-- 3. Payment confirms; cancelling a paid booking refunds it
-- =========================================================================
set local role service_role;
select is((select amount_minor from public.payment_begin_booking(pg_temp.fx('dave'), pg_temp.bk('b1'), 'test', 'test')), 600000::bigint,
  '3. the payment amount is the booking''s');
select throws_ok(format($$ select * from public.payment_begin_booking(%L, pg_temp.bk('b2'), 'test', 'test') $$, pg_temp.fx('erin')), '22023', null,
  '3. an unaccepted booking cannot be paid');
select public.payment_attach_session((select id from public.payments where booking_id = pg_temp.bk('b1')), 'ref_b1', 'https://pay.example/b1', now() + interval '15 minutes');
select is(public.payment_apply_event('test', 'ev_b1', 'ref_b1', 'succeeded', 600000, 'JMD', now(), null, 'webhook'), 'applied', '3. paid');
select is(pg_temp.bstatus('b1'), 'confirmed', '3. confirmed');
select is((select coalesce(sum(e.amount_minor), 0)::bigint from public.ledger_entries e join public.ledger_transactions t on t.id = e.transaction_id
           where t.community_id = pg_temp.fx('A')), 0::bigint, '3. ledger balanced');
reset role;
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.booking_cancel(pg_temp.bk('b1'), '') $$, '22023', null, '3. a reason is required');
select lives_ok($$ select public.booking_cancel(pg_temp.bk('b1'), 'Plans changed') $$, '3. the buyer cancels');
select results_eq($$ select kind, status, amount_minor, booking_id = pg_temp.bk('b1') from public.refunds $$,
  $$ values ('automatic'::text, 'approved'::text, 600000::bigint, true) $$, '3. a full refund record (no cancellation fee: D6)');
reset role;
select is((select seller_user_id from public.refunds where booking_id = pg_temp.bk('b1')), pg_temp.fx('carol'), '3. the refund belongs to the seller''s balance');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok($$ select public.booking_accept(pg_temp.bk('b2')) $$, '3. the freed time can now be accepted');

-- =========================================================================
-- 4. Jobs
-- =========================================================================
reset role;
update public.bookings set payment_due_at = now() - interval '1 minute' where id = pg_temp.bk('b2');
set local role service_role;
select is(public.expire_unpaid_bookings(), 1, '4. unpaid accepted bookings expire');
reset role;
select is(pg_temp.bstatus('b2'), 'expired', '4. expired');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.expire_unpaid_bookings() $$, '42501', null, '4. jobs are server-only');

select * from finish();
rollback;

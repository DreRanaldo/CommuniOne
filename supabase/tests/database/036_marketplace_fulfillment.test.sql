-- Marketplace Stages G-H (migration 36): seller-only order steps, no skipping, pickup codes (buyer-only, lockout), delivery with seller-recorded tracking only, rejection/cancellation with stock back and one full refund, buyer cancel, scheduled jobs.
begin;
create extension if not exists pgtap with schema extensions;

select plan(47);

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


-- Catalog fixture (trusted setup): carol (GCT-registered, delivers to Kingston) and erin sell in A.
insert into public.seller_profiles (id, community_id, user_id, display_name, gct_registered) values
  ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), pg_temp.fx('carol'), 'Carol Shop', true),
  ('5e000000-0000-4000-8000-000000000002', pg_temp.fx('A'), pg_temp.fx('erin'),  'Erin Books', false);
insert into public.delivery_options (seller_profile_id, community_id, fee_minor, parishes, estimated_days_min, estimated_days_max)
  values ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), 50000, '{Kingston}', 1, 2);
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, condition, price_minor, fulfillment, status) values
  ('1a000000-0000-4000-8000-000000000001', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Radio', 'good', 500000, '{pickup,seller_delivery}', 'active'),
  ('1a000000-0000-4000-8000-000000000002', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Lamp', 'new', 250000, '{pickup,seller_delivery}', 'active'),
  ('1a000000-0000-4000-8000-000000000003', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000002', pg_temp.fx('erin'), 'product',
   (select id from public.market_categories where slug = 'books-media'), 'Book', 'good', 100000, '{pickup}', 'active');
update public.inventory set on_hand = 3 where listing_id = '1a000000-0000-4000-8000-000000000001';
update public.inventory set on_hand = 1 where listing_id = '1a000000-0000-4000-8000-000000000002';
update public.inventory set on_hand = 5 where listing_id = '1a000000-0000-4000-8000-000000000003';

create function pg_temp.choices(p_carol text, p_erin text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000001', 'method', p_carol),
    jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', p_erin))
$$;
create function pg_temp.reserved(p_listing text) returns int language sql security definer as $$
  select reserved from public.inventory where listing_id = p_listing::uuid
$$;

-- dave buys 2 Radios from carol (pickup) and 1 Book from erin (pickup); then
-- a second checkout: 1 Lamp from carol (delivery). Both paid via the
-- service-role payment API (as the webhook would).
reset role;
insert into public.delivery_options (seller_profile_id, community_id, fee_minor, parishes)
  values ('5e000000-0000-4000-8000-000000000002', pg_temp.fx('A'), 20000, '{}')
  on conflict (seller_profile_id) do nothing;
select pg_temp.login(pg_temp.fx('dave'));
insert into public.addresses (recipient_name, phone, line1, town, parish, is_default) values ('Dave D', '876 555 0101', '1 Hope Rd', 'Kingston', 'Kingston', true);
select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 2);
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e1', pg_temp.choices('pickup', 'pickup'),
  null, 'Dave D', '876 555 0101', 1250000, 'v1');
select public.cart_set_item('1a000000-0000-4000-8000-000000000002', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e2',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000001', 'method', 'seller_delivery')),
  (select id from public.addresses), 'Dave D', '876 555 0101', 337500, 'v1');
reset role;
create function pg_temp.ck(p text) returns uuid language sql security definer as $$ select id from public.checkouts where client_request_id = ('00000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.pay(p text) returns text language plpgsql as $$
declare v uuid;
begin
  select payment_id into v from public.payment_begin(pg_temp.fx('dave'), pg_temp.ck(p), 'test', 'test');
  perform public.payment_attach_session(v, 'ref_' || p, 'https://pay.example/' || p, now() + interval '15 minutes');
  return public.payment_apply_event('test', 'ev_' || p, 'ref_' || p, 'succeeded',
    (select total_minor from public.checkouts where id = pg_temp.ck(p)), 'JMD', now(), null, 'webhook');
end $$;
create function pg_temp.ord(p text, p_seller text) returns uuid language sql security definer as $$
  select id from public.orders where checkout_id = pg_temp.ck(p) and seller_user_id = pg_temp.fx(p_seller) $$;
create function pg_temp.status(p_order uuid) returns text language sql security definer as $$ select status from public.orders where id = p_order $$;
create function pg_temp.on_hand(p_listing text) returns int language sql security definer as $$ select on_hand from public.inventory where listing_id = p_listing::uuid $$;

-- =========================================================================
-- 1. Nothing to do before payment; then only the order's own seller acts
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e1', 'carol')), 'P0002', null,
  '1. an unpaid order is invisible to its seller');
reset role;
select is(pg_temp.pay('e1'), 'applied', '1. first checkout paid');
select is(pg_temp.pay('e2'), 'applied', '1. second checkout paid');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e1', 'carol')), 'P0002', null,
  '1. another seller cannot accept it');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e1', 'carol')), 'P0002', null,
  '1. nor can the buyer');
select throws_ok($$ update public.orders set status = 'completed' $$, '42501', null, '1. status is never written directly');

-- =========================================================================
-- 2. Pickup: accept, prepare, ready (buyer gets a code), handover by code
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.order_ready_for_pickup(%L) $$, pg_temp.ord('e1', 'carol')), '22023', null,
  '2. steps cannot be skipped (paid -> ready)');
select lives_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e1', 'carol')), '2. the seller accepts');
select throws_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e1', 'carol')), '22023', null, '2. only once');
select throws_ok(format($$ select public.order_dispatch(%L) $$, pg_temp.ord('e1', 'carol')), '22023', 'this order is picked up, not delivered',
  '2. a pickup order is not dispatched');
select lives_ok(format($$ select public.order_start_processing(%L) $$, pg_temp.ord('e1', 'carol')), '2. preparing');
select lives_ok(format($$ select public.order_ready_for_pickup(%L, 'Shop on Hope Rd, 9-5') $$, pg_temp.ord('e1', 'carol')), '2. ready');
select is_empty($$ select code from public.order_pickup_codes $$, '2. the seller cannot read the pickup code');
select pg_temp.login(pg_temp.fx('dave'));
select matches((select code from public.order_pickup_codes where order_id = pg_temp.ord('e1', 'carol')), '^[0-9]{6}$', '2. the buyer has a 6-digit code');
create temp table pickup as select code from public.order_pickup_codes where order_id = pg_temp.ord('e1', 'carol');
select pg_temp.login(pg_temp.fx('carol'));
select is(public.order_confirm_pickup(pg_temp.ord('e1', 'carol'), case when (select code from pickup) = '000000' then '111111' else '000000' end),
  'wrong_code', '2. a wrong code does not complete the order');
select is(pg_temp.status(pg_temp.ord('e1', 'carol')), 'ready_for_pickup', '2. still ready');
select is(public.order_confirm_pickup(pg_temp.ord('e1', 'carol'), (select code from pickup)), 'completed', '2. the right code completes it');
select is(pg_temp.status(pg_temp.ord('e1', 'carol')), 'completed', '2. completed');
select is((select count(*)::int from public.order_events where order_id = pg_temp.ord('e1', 'carol')), 6,
  '2. every step is in the history (pending, paid, accepted, processing, ready, completed)');
reset role;
select is((select count(*)::int from public.notifications where user_id = pg_temp.fx('dave') and type = 'order'), 3,
  '2. the buyer was told: accepted, ready, collected');

-- =========================================================================
-- 3. Wrong codes lock
-- =========================================================================
update public.orders set status = 'ready_for_pickup' where id = pg_temp.ord('e1', 'erin');
insert into public.order_pickup_codes (order_id, code, failed_attempts) values (pg_temp.ord('e1', 'erin'), '123456', 5);
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ select public.order_confirm_pickup(%L, '123456') $$, pg_temp.ord('e1', 'erin')), '22023',
  'too many wrong codes; ask a community admin for help', '3. five wrong codes lock the handover');

-- =========================================================================
-- 4. Delivery: dispatch with the seller's own tracking details, fail, retry, deliver, confirm
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e2', 'carol')), '4. accepted');
select throws_ok(format($$ select public.order_dispatch(%L, 'Knutsford', 'KX1', 'http://track.example/KX1') $$, pg_temp.ord('e2', 'carol')),
  '22023', 'a tracking link must start with https://', '4. tracking links must be https');
select lives_ok(format($$ select public.order_dispatch(%L, 'Knutsford Express', 'KX123') $$, pg_temp.ord('e2', 'carol')), '4. dispatched');
select lives_ok(format($$ select public.order_mark_delivery_failed(%L, 'Nobody home') $$, pg_temp.ord('e2', 'carol')), '4. a failed attempt');
select lives_ok(format($$ select public.order_dispatch(%L, 'Knutsford Express', 'KX124') $$, pg_temp.ord('e2', 'carol')), '4. sent again');
select lives_ok(format($$ select public.order_mark_delivered(%L) $$, pg_temp.ord('e2', 'carol')), '4. delivered');
select pg_temp.login(pg_temp.fx('dave'));
select results_eq(format($$ select courier_name, tracking_reference, attempts, delivered_at is not null from public.order_shipments where order_id = %L $$, pg_temp.ord('e2', 'carol')),
  $$ values ('Knutsford Express'::text, 'KX124'::text, 2, true) $$, '4. the buyer sees what the seller recorded');
select lives_ok(format($$ select public.order_confirm_received(%L) $$, pg_temp.ord('e2', 'carol')), '4. the buyer confirms');
select is(pg_temp.status(pg_temp.ord('e2', 'carol')), 'completed', '4. completed');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.order_shipments $$, '4. nobody else sees shipments');

-- =========================================================================
-- 5. Reject / cancel: stock back, full refund record, never twice
-- =========================================================================
reset role;
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 0) from (select pg_temp.login(pg_temp.fx('dave'))) x;
select pg_temp.login(pg_temp.fx('dave'));
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 2);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e3',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', 'pickup')),
  null, 'Dave D', '876 555 0101', 200000, 'v1');
reset role;
select pg_temp.pay('e3');
select is(pg_temp.on_hand('1a000000-0000-4000-8000-000000000003'), 2, '5. stock taken by the paid orders (5 - 1 - 2)');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ select public.order_reject(%L, '') $$, pg_temp.ord('e3', 'erin')), '22023', null, '5. a rejection needs a reason');
select lives_ok(format($$ select public.order_reject(%L, 'Damaged copy') $$, pg_temp.ord('e3', 'erin')), '5. the seller rejects');
select is(pg_temp.status(pg_temp.ord('e3', 'erin')), 'rejected', '5. rejected');
reset role;
select is(pg_temp.on_hand('1a000000-0000-4000-8000-000000000003'), 4, '5. stock returned');
select results_eq(format($$ select kind, status, amount_minor from public.refunds where order_id = %L $$, pg_temp.ord('e3', 'erin')),
  $$ values ('automatic'::text, 'approved'::text, 200000::bigint) $$, '5. a full refund record, waiting to be processed');
select is((select count(*)::int from public.audit_logs where action = 'order.cancelled' and entity_id = pg_temp.ord('e3', 'erin')), 1, '5. audited');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ select public.order_seller_cancel(%L, 'again') $$, pg_temp.ord('e3', 'erin')), '22023', null,
  '5. a rejected order cannot be cancelled again (no second refund)');

-- =========================================================================
-- 6. Buyer cancel before acceptance; scheduled jobs
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e4',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', 'pickup')),
  null, 'Dave D', '876 555 0101', 100000, 'v1');
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e5',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', 'pickup')),
  null, 'Dave D', '876 555 0101', 100000, 'v1');
reset role;
select pg_temp.pay('e4');
select pg_temp.pay('e5');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok(format($$ select public.order_buyer_cancel(%L, 'Changed my mind') $$, pg_temp.ord('e4', 'erin')), '6. the buyer cancels before acceptance');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ select public.order_accept(%L) $$, pg_temp.ord('e5', 'erin')), '6. the other one is accepted');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select public.order_buyer_cancel(%L) $$, pg_temp.ord('e5', 'erin')), '22023', null,
  '6. after acceptance the buyer asks for a refund instead (Stage I)');
reset role;
select is((select count(*)::int from public.refunds where order_id = pg_temp.ord('e4', 'erin')), 1, '6. refund record for the cancelled order');
update public.checkouts set paid_at = now() - interval '3 days' where id = pg_temp.ck('e5');
update public.orders set status = 'paid' where id = pg_temp.ord('e5', 'erin');
set local role service_role;
select is(public.expire_unaccepted_orders(), 1, '6. unaccepted paid orders older than 48 hours are cancelled');
reset role;
select is(pg_temp.status(pg_temp.ord('e5', 'erin')), 'cancelled', '6. cancelled and refunded');
update public.orders set status = 'delivered' where id = pg_temp.ord('e2', 'carol');
update public.order_shipments set delivered_at = now() - interval '8 days' where order_id = pg_temp.ord('e2', 'carol');
set local role service_role;
select is(public.complete_delivered_orders(), 1, '6. delivered orders complete after 7 days');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.expire_unaccepted_orders() $$, '42501', null, '6. jobs are server-only');

select * from finish();
rollback;

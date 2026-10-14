-- Marketplace Stage D (migration 34): server-priced checkout (fees, GCT, totals), idempotency, reservations, per-seller orders, privacy, immutability, cancel and expiry.
begin;
create extension if not exists pgtap with schema extensions;

select plan(34);

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

select pg_temp.login(pg_temp.fx('dave'));
select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 2);
select public.cart_set_item('1a000000-0000-4000-8000-000000000002', 1);
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
insert into public.addresses (recipient_name, phone, line1, town, parish, is_default) values ('Dave D', '876 555 0101', '1 Hope Rd', 'Kingston', 'Kingston', true);
insert into public.addresses (recipient_name, phone, line1, town, parish) values ('Dave D', '876 555 0101', '2 Main St', 'Ocho Rios', 'St. Ann');
create function pg_temp.addr(p_parish text) returns uuid language sql as $$ select id from public.addresses where parish = p_parish $$;

-- =========================================================================
-- 1. Preview: the server prices everything
-- =========================================================================
select is(
  (select jsonb_agg(x->>'problem' order by x->>'problem') from jsonb_array_elements(public.checkout_preview(pg_temp.fx('A'))->'problems') x),
  '["choose_fulfillment", "choose_fulfillment"]'::jsonb, '1. each seller needs a pickup or delivery choice');
select results_eq(
  format($$ select (p->>'subtotal_minor')::bigint, (p->>'delivery_minor')::bigint, (p->>'tax_minor')::bigint, (p->>'total_minor')::bigint, jsonb_array_length(p->'problems')
            from public.checkout_preview(%L, pg_temp.choices('seller_delivery', 'pickup'), %L) p $$, pg_temp.fx('A'), pg_temp.addr('Kingston')),
  $$ values (1350000::bigint, 50000::bigint, 187500::bigint, 1587500::bigint, 0) $$,
  '1. subtotal, delivery fee, GCT (registered seller only) and total');
select is(
  (select x->>'problem' from jsonb_array_elements(public.checkout_preview(pg_temp.fx('A'), pg_temp.choices('pickup', 'seller_delivery'), pg_temp.addr('Kingston'))->'problems') x),
  'method_not_offered', '1. a seller who does not deliver cannot be chosen for delivery');
select is(
  (select x->>'problem' from jsonb_array_elements(public.checkout_preview(pg_temp.fx('A'), pg_temp.choices('seller_delivery', 'pickup'), pg_temp.addr('St. Ann'))->'problems') x),
  'delivery_not_available', '1. delivery only to the seller''s parishes');

-- =========================================================================
-- 2. Create: re-priced, locked, reserved, idempotent
-- =========================================================================
select throws_ok(
  format($$ select public.checkout_create(%L, '00000000-0000-4000-8000-0000000000c1', pg_temp.choices('seller_delivery', 'pickup'), %L, 'Dave D', '876 555 0101', 100, 'v1') $$,
    pg_temp.fx('A'), pg_temp.addr('Kingston')),
  '22023', 'the total changed to 1587500; review your order', '2. a total the buyer did not see is refused');
select lives_ok(
  format($$ select public.checkout_create(%L, '00000000-0000-4000-8000-0000000000c1', pg_temp.choices('seller_delivery', 'pickup'), %L, 'Dave D', '876 555 0101', 1587500, 'v1') $$,
    pg_temp.fx('A'), pg_temp.addr('Kingston')),
  '2. the buyer places the order');
select results_eq($$ select status, total_minor from public.checkouts $$, $$ values ('awaiting_payment'::text, 1587500::bigint) $$,
  '2. one checkout awaiting payment');
select results_eq($$ select seller_name, status, fulfillment_method, total_minor, address_snapshot->>'parish' from public.orders order by seller_name $$,
  $$ values ('Carol Shop'::text, 'pending_payment'::text, 'seller_delivery'::text, 1487500::bigint, 'Kingston'::text),
            ('Erin Books', 'pending_payment', 'pickup', 100000, null) $$,
  '2. one order per seller with its own totals; the address only where delivered');
select results_eq($$ select title_snapshot, unit_price_minor, quantity, tax_minor from public.order_items order by title_snapshot $$,
  $$ values ('Book'::text, 100000::bigint, 1, 0::bigint), ('Lamp', 250000, 1, 37500), ('Radio', 500000, 2, 150000) $$,
  '2. purchase-time snapshots');
select results_eq($$ select pg_temp.reserved('1a000000-0000-4000-8000-000000000001'), pg_temp.reserved('1a000000-0000-4000-8000-000000000002') $$,
  $$ values (2, 1) $$, '2. stock is reserved');
select is_empty($$ select 1 from public.cart_items $$, '2. the cart is emptied');
select is(
  public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000c1', pg_temp.choices('pickup', 'pickup'), null, 'x', '876 555 0101', 0, 'v1'),
  (select id from public.checkouts), '2. a retried request returns the same checkout');
select is((select count(*)::int from public.orders), 2, '2. ...and creates nothing new');

-- =========================================================================
-- 3. No overselling; nobody else sees the order
-- =========================================================================
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000002', 1) $$, '22023', 'only 0 available',
  '3. reserved stock cannot be sold twice');
select is_empty($$ select 1 from public.orders $$, '3. other members see no orders');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.orders $$, '3. a seller sees nothing (not even contact details) before payment');
reset role;
update public.checkouts set paid_at = now();
select pg_temp.login(pg_temp.fx('carol'));
select results_eq($$ select seller_name, contact_snapshot->>'phone' from public.orders $$, $$ values ('Carol Shop'::text, '876 555 0101'::text) $$,
  '3. once paid, a seller sees only her own order, with the contact she needs');
select is_empty($$ select 1 from public.checkouts $$, '3. but not the buyer''s checkout');
select is_empty($$ select 1 from public.addresses $$, '3. nor the buyer''s saved addresses');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.order_items $$, '3. another community sees nothing');

-- =========================================================================
-- 4. Records cannot be rewritten
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ update public.orders set status = 'completed' $$, '42501', null, '4. buyers cannot change an order');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ update public.orders set total_minor = 1 $$, '42501', null, '4. nor sellers');
reset role;
update public.checkouts set paid_at = null;
select throws_ok($$ update public.orders set total_minor = 1 $$, '42501', 'order totals and details are immutable',
  '4. totals are frozen even for trusted code');
select throws_ok($$ delete from public.order_items $$, '42501', null, '4. purchase-time items are append-only');

-- =========================================================================
-- 5. Cancel and expiry release stock
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.checkout_cancel(%L) $$, (select id from public.checkouts)), 'P0002', null,
  '5. only the buyer cancels');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok(format($$ select public.checkout_cancel(%L) $$, (select id from public.checkouts)), '5. the buyer cancels before paying');
select results_eq($$ select status from public.orders $$, $$ values ('cancelled'::text), ('cancelled') $$, '5. both orders cancelled');
select results_eq($$ select pg_temp.reserved('1a000000-0000-4000-8000-000000000001'), pg_temp.reserved('1a000000-0000-4000-8000-000000000002') $$,
  $$ values (0, 0) $$, '5. stock released');
select is((select count(*)::int from public.order_events where to_status = 'cancelled'), 2, '5. the cancellation is in the history');
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 2);
select lives_ok($$ select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000c2',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', 'pickup')),
  null, 'Dave D', '876 555 0101', 200000, 'v1') $$, '5. a second order');
reset role;
update public.checkouts set reservation_expires_at = now() - interval '1 minute' where client_request_id = '00000000-0000-4000-8000-0000000000c2';
select is(public.expire_checkouts(), 1, '5. the expiry job finds the unpaid checkout');
select results_eq($$ select status from public.checkouts where client_request_id = '00000000-0000-4000-8000-0000000000c2' $$,
  $$ values ('expired'::text) $$, '5. expired');
select is(pg_temp.reserved('1a000000-0000-4000-8000-000000000003'), 0, '5. and its stock released');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.expire_checkouts() $$, '42501', null, '5. the expiry job is not callable by clients');

select * from finish();
rollback;

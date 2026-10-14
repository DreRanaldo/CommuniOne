-- Marketplace Stage C (migration 33): cart lines priced by the server, stock limits, own listings, services, isolation, no direct writes.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

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


-- Catalog fixture (trusted setup): carol sells in A, frank in B.
insert into public.seller_profiles (id, community_id, user_id, display_name) values
  ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), pg_temp.fx('carol'), 'Carol Shop'),
  ('5e000000-0000-4000-8000-000000000002', pg_temp.fx('B'), pg_temp.fx('frank'), 'Frank Shop');
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, condition, price_minor, fulfillment, status) values
  ('1a000000-0000-4000-8000-000000000001', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Radio', 'good', 500000, '{pickup}', 'active'),
  ('1a000000-0000-4000-8000-000000000002', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Lamp', 'new', 250000, '{pickup,seller_delivery}', 'active'),
  ('1a000000-0000-4000-8000-000000000003', pg_temp.fx('B'), '5e000000-0000-4000-8000-000000000002', pg_temp.fx('frank'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'B kettle', 'new', 100000, '{pickup}', 'active');
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, pricing, price_minor, status) values
  ('1a000000-0000-4000-8000-000000000004', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'service',
   (select id from public.market_categories where slug = 'cleaning'), 'Cleaning', 'fixed', 300000, 'active');
update public.inventory set on_hand = 3 where listing_id = '1a000000-0000-4000-8000-000000000001';
update public.inventory set on_hand = 1 where listing_id = '1a000000-0000-4000-8000-000000000002';
update public.inventory set on_hand = 5 where listing_id = '1a000000-0000-4000-8000-000000000003';

create function pg_temp.lines() returns table (title text, quantity int, line_total bigint, issue text, subtotal bigint)
language sql as $$
  select title, quantity, line_total_minor, issue, subtotal_minor from public.cart_quote(pg_temp.fx('A')) order by title
$$;

-- =========================================================================
-- 1. Adding, changing, removing
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select is(public.cart_set_item('1a000000-0000-4000-8000-000000000001', 2), 2, '1. a member adds 2 radios');
select is(public.cart_set_item('1a000000-0000-4000-8000-000000000002', 1), 1, '1. and a lamp');
select results_eq($$ select * from pg_temp.lines() $$,
  $$ values ('Lamp'::text, 1, 250000::bigint, null::text, 1250000::bigint), ('Radio', 2, 1000000::bigint, null, 1250000::bigint) $$,
  '1. the server prices every line and the total');
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 4) $$, '22023', 'only 3 available',
  '1. never more than available');
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 100) $$, '22023', null, '1. at most 99');
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000004', 1) $$, '22023', 'services are booked, not added to the cart',
  '1. services are booked instead');
select is(public.cart_set_item('1a000000-0000-4000-8000-000000000002', 0), 0, '1. quantity 0 removes a line');
select results_eq($$ select title from pg_temp.lines() $$, $$ values ('Radio'::text) $$, '1. ...gone');

-- =========================================================================
-- 2. Who may buy what
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 1) $$, '22023', 'you cannot buy your own listing',
  '2. nobody buys their own listing');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1) $$, 'P0002', null,
  '2. another community''s listing does not exist for you');
select throws_ok(format($$ select * from public.cart_quote(%L) $$, pg_temp.fx('B')), '42501', null, '2. nor its cart');
select throws_ok($$ insert into public.cart_items (cart_id, community_id, listing_id, quantity, seen_price_minor)
  select id, community_id, '1a000000-0000-4000-8000-000000000002', 1, 1 from public.carts $$,
  '42501', null, '2. no direct writes (a client cannot choose a price)');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok($$ select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 1) $$, 'P0002', null, '2. pending members cannot shop');
select pg_temp.login(pg_temp.fx('erin'));
select is_empty($$ select 1 from public.cart_items $$, '2. nobody sees another member''s cart');

-- =========================================================================
-- 3. Changes after adding are reported, never silently charged
-- =========================================================================
reset role;
update public.listings set price_minor = 550000 where id = '1a000000-0000-4000-8000-000000000001';
select pg_temp.login(pg_temp.fx('dave'));
select results_eq($$ select line_total, issue, subtotal from pg_temp.lines() $$,
  $$ values (1100000::bigint, 'price_changed'::text, 1100000::bigint) $$, '3. a new price is used and flagged');
reset role;
update public.inventory set on_hand = 1 where listing_id = '1a000000-0000-4000-8000-000000000001';
select pg_temp.login(pg_temp.fx('dave'));
select results_eq($$ select line_total, issue, subtotal from pg_temp.lines() $$,
  $$ values (0::bigint, 'insufficient_stock'::text, 0::bigint) $$, '3. too few left: not counted');
reset role;
update public.listings set status = 'paused' where id = '1a000000-0000-4000-8000-000000000001';
select pg_temp.login(pg_temp.fx('dave'));
select results_eq($$ select issue from pg_temp.lines() $$, $$ values ('unavailable'::text) $$, '3. paused: unavailable');
select lives_ok(format($$ select public.cart_clear(%L) $$, pg_temp.fx('A')), '3. the cart can be emptied');
select is_empty($$ select * from pg_temp.lines() $$, '3. ...empty');

select * from finish();
rollback;

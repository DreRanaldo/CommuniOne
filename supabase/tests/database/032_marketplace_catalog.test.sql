-- Marketplace Stage B (migration 32): permissions, seller profiles, listings, visibility, moderation, stock, pictures, search, favorites, isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(63);

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


select set_config('storage.allow_delete_query', 'true', true);

-- Helpers (owner, before any login).
create function pg_temp.img(p_community text, p_user text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_community)::text || '/' || pg_temp.fx(p_user)::text || '/' || p_file
$$;
create function pg_temp.upload(p_name text) returns void language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values ('listing-images', p_name, '{"size": 1000, "mimetype": "image/jpeg"}');
end;
$$;
create function pg_temp.cat(p_slug text) returns uuid language sql stable as $$
  select id from public.market_categories where slug = p_slug
$$;
create function pg_temp.listing(p_title text) returns uuid language sql security definer as $$
  select id from public.listings where title = p_title
$$;
create function pg_temp.seller(p_user text, p_community text) returns uuid language sql security definer as $$
  select id from public.seller_profiles where user_id = pg_temp.fx(p_user) and community_id = pg_temp.fx(p_community)
$$;
create function pg_temp.search(p_community text, p_query text default null, p_in_stock boolean default false, p_favorites boolean default false)
returns setof text language sql as $$
  select title from public.search_listings(pg_temp.fx(p_community), p_query, null, null, null, null, null, p_in_stock, null, p_favorites, 'newest', 24, 0)
$$;

select is((select public from storage.buckets where id = 'listing-images'), false, 'the listing-images bucket is private');

-- =========================================================================
-- 1. Permissions (from the templates, not role names)
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'marketplace.sell')
      and public.has_community_permission(pg_temp.fx('A'), 'marketplace.buy')
      and public.has_community_permission(pg_temp.fx('A'), 'marketplace.view'), '1. a Member views, buys and sells');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'marketplace.manage'), '1. ...but does not manage');
select pg_temp.login(pg_temp.fx('erin'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'marketplace.manage'), '1. an Admin manages the marketplace');
select pg_temp.login(pg_temp.fx('grace'));
select ok(not public.has_community_permission(pg_temp.fx('A'), 'marketplace.view'), '1. a pending member has no marketplace access');

-- =========================================================================
-- 2. Seller profiles
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ insert into public.seller_profiles (community_id, display_name, bio) values (%L, 'Carol''s Corner', 'Gadgets') $$, pg_temp.fx('A')),
  '2. a Member opens a shop in her community');
select results_eq(
  format($$ select user_id, status, verification_status from public.seller_profiles where id = %L $$, pg_temp.seller('carol', 'A')),
  format($$ values (%L::uuid, 'active', 'unverified') $$, pg_temp.fx('carol')),
  '2. owner, status and verification are set by the server');
select throws_ok(format($$ update public.seller_profiles set verification_status = 'verified' where id = %L $$, pg_temp.seller('carol', 'A')),
  '42501', null, '2. nobody verifies themselves');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(format($$ insert into public.seller_profiles (community_id, display_name) values (%L, 'Intruder') $$, pg_temp.fx('A')),
  '42501', null, '2. not in a community you do not belong to');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok(format($$ insert into public.seller_profiles (community_id, display_name) values (%L, 'Dave Fixes') $$, pg_temp.fx('A')),
  '2. a Moderator opens a shop too');

-- =========================================================================
-- 3. Listings
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, description, condition, price_minor, fulfillment, status)
  values (%L, %L, 'product', %L, 'Used laptop', 'A fast laptop, 8GB RAM', 'good', 4500000, '{pickup}', 'active') $$,
  pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('electronics')), '3. she lists a product');
select results_eq(
  $$ select l.seller_user_id, l.published_at is not null, i.on_hand, i.reserved from public.listings l join public.inventory i on i.listing_id = l.id where l.title = 'Used laptop' $$,
  format($$ values (%L::uuid, true, 0, 0) $$, pg_temp.fx('carol')),
  '3. seller and publication set by the server; stock starts at 0');
select lives_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, pricing, status, service_area)
  values (%L, %L, 'service', %L, 'Phone screen repair', 'quote', 'active', 'Kingston') $$,
  pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('tech-help')), '3. and a quote-priced service');
select lives_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, condition, price_minor, fulfillment)
  values (%L, %L, 'product', %L, 'Secret draft', 'new', 100, '{pickup}') $$,
  pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('books-media')), '3. and a draft');
select throws_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, price_minor, fulfillment)
  values (%L, %L, 'product', %L, 'No condition', 100, '{pickup}') $$, pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('electronics')),
  '23514', null, '3. products need a condition');
select throws_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, price_minor)
  values (%L, %L, 'service', %L, 'Wrong category', 100) $$, pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('electronics')),
  '22023', null, '3. services need a service category');
select throws_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, pricing, price_minor)
  values (%L, %L, 'service', %L, 'Quote with price', 'quote', 100) $$, pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('cleaning')),
  '23514', null, '3. a quote has no price');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, condition, price_minor, fulfillment)
  values (%L, %L, 'product', %L, 'Impersonation', 'new', 1, '{pickup}') $$, pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('electronics')),
  '42501', null, '3. nobody lists under someone else''s shop');

-- =========================================================================
-- 4. Visibility
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select set_eq($$ select title from public.listings $$, array['Used laptop', 'Phone screen repair'],
  '4. members see active listings, not other people''s drafts');
select pg_temp.login(pg_temp.fx('carol'));
select ok(exists (select 1 from public.listings where title = 'Secret draft'), '4. the seller sees her draft');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.listings $$, '4. another community sees nothing');
select pg_temp.login(pg_temp.fx('grace'));
select is_empty($$ select 1 from public.listings $$, '4. a pending member sees nothing');

-- =========================================================================
-- 5. Changes and moderation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
update public.listings set price_minor = 4200000 where id = pg_temp.listing('Used laptop');
select is((select price_minor from public.listings where title = 'Used laptop'), 4200000::bigint, '5. the seller changes her price');
select throws_ok(format($$ update public.listings set status = 'paused' where id = %L $$, pg_temp.listing('Secret draft')),
  '22023', null, '5. a draft is published, not paused');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty(format($$ update public.listings set price_minor = 1 where id = %L returning 1 $$, pg_temp.listing('Used laptop')),
  '5. other members cannot change it');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ update public.listings set price_minor = 1 where id = %L $$, pg_temp.listing('Phone screen repair')),
  '42501', null, '5. a manager cannot edit a listing');
select throws_ok(format($$ update public.listings set status = 'removed' where id = %L $$, pg_temp.listing('Phone screen repair')),
  '22023', null, '5. removal needs a reason');
select lives_ok(format($$ update public.listings set status = 'removed', removal_reason = 'Counterfeit parts' where id = %L $$, pg_temp.listing('Phone screen repair')),
  '5. a manager removes a listing with a reason');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'listing.removed' and entity_id = pg_temp.listing('Phone screen repair')), 1,
  '5. the removal is audited');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ update public.listings set status = 'active' where id = %L $$, pg_temp.listing('Phone screen repair')),
  '42501', null, '5. a removed listing stays removed');

-- =========================================================================
-- 6. Stock
-- =========================================================================
select results_eq(format($$ select on_hand, reserved, available from public.set_listing_stock(%L, 5) $$, pg_temp.listing('Used laptop')),
  $$ values (5, 0, 5) $$, '6. the seller sets her stock');
select lives_ok(format($$ select public.set_listing_stock(%L, 8, 'new delivery') $$, pg_temp.listing('Used laptop')), '6. and restocks');
select results_eq(
  format($$ select reason, delta, on_hand_after from public.inventory_movements where listing_id = %L order by created_at, on_hand_after $$, pg_temp.listing('Used laptop')),
  $$ values ('initial', 5, 5), ('restock', 3, 8) $$, '6. every change is recorded');
select throws_ok(format($$ select public.set_listing_stock(%L, -1) $$, pg_temp.listing('Used laptop')), '22023', null, '6. no negative stock');
select throws_ok(format($$ delete from public.inventory_movements where listing_id = %L $$, pg_temp.listing('Used laptop')),
  '42501', null, '6. stock history cannot be erased');
select throws_ok(format($$ update public.inventory set on_hand = 999 where listing_id = %L $$, pg_temp.listing('Used laptop')),
  '42501', null, '6. stock is never written directly');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select public.set_listing_stock(%L, 100) $$, pg_temp.listing('Used laptop')), 'P0002', null,
  '6. nobody else changes it');
select is((select available from public.search_listings(pg_temp.fx('A'), 'laptop', null, null, null, null, null, false, null, false, 'newest', 24, 0)), 8,
  '6. buyers see what is available');

-- =========================================================================
-- 7. Pictures
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '7. the seller uploads a picture into her own folder');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'dave', '22222222-2222-4222-8222-222222222222.jpg')),
  '42501', null, '7. not into someone else''s folder');
select lives_ok(format($$ insert into public.listing_images (listing_id, community_id, storage_path, position, width, height) values (%L, %L, %L, 0, 800, 600) $$,
  pg_temp.listing('Used laptop'), pg_temp.fx('A'), pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '7. and adds it to her listing');
select throws_ok(format($$ insert into public.listing_images (listing_id, community_id, storage_path, position, width, height) values (%L, %L, %L, 1, 800, 600) $$,
  pg_temp.listing('Used laptop'), pg_temp.fx('A'), pg_temp.img('A', 'carol', '33333333-3333-4333-8333-333333333333.jpg')),
  '22023', null, '7. a picture that was never uploaded is refused');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ insert into public.listing_images (listing_id, community_id, storage_path, position, width, height) values (%L, %L, %L, 1, 800, 600) $$,
  pg_temp.listing('Used laptop'), pg_temp.fx('A'), pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '42501', null, '7. nobody adds pictures to another seller''s listing');
select isnt_empty(format($$ select 1 from storage.objects where bucket_id = 'listing-images' and name = %L $$,
  pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), '7. members can see the picture of an active listing');
select is((select cover_image_path from public.search_listings(pg_temp.fx('A'), 'laptop', null, null, null, null, null, false, null, false, 'newest', 24, 0)),
  pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg'), '7. the first picture is the cover');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty(format($$ select 1 from storage.objects where bucket_id = 'listing-images' and name = %L $$,
  pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), '7. other communities cannot');

-- =========================================================================
-- 8. Search and favorites
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select results_eq($$ select * from pg_temp.search('A', 'laptops') $$, $$ values ('Used laptop'::text) $$, '8. full-text search (stemmed)');
select results_eq($$ select * from pg_temp.search('A', 'lapt') $$, $$ values ('Used laptop'::text) $$, '8. partial words match the title');
select is_empty($$ select * from pg_temp.search('A', '100%') $$, '8. wildcards are literal');
select results_eq(
  format($$ select title from public.search_listings(%L, null, %L, null, null, null, null, false, null, false, 'newest', 24, 0) $$, pg_temp.fx('A'), pg_temp.cat('furniture')),
  $$ select null::text where false $$, '8. category filter');
select is_empty(
  format($$ select 1 from public.search_listings(%L, null, null, null, null, 5000000, null, false, null, false, 'newest', 24, 0) $$, pg_temp.fx('A')),
  '8. price filter');
select throws_ok(format($$ select * from public.search_listings(%L, null, null, null, null, null, null, false, null, false, 'cheapest', 24, 0) $$, pg_temp.fx('A')),
  '22023', null, '8. unknown sort orders are refused');
select lives_ok(format($$ insert into public.favorites (listing_id) values (%L) $$, pg_temp.listing('Used laptop')), '8. a member saves a listing');
select results_eq($$ select * from pg_temp.search('A', null, false, true) $$, $$ values ('Used laptop'::text) $$, '8. saved listings');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.favorites $$, '8. nobody sees other people''s saved listings');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(format($$ select * from public.search_listings(%L) $$, pg_temp.fx('A')), '42501', null, '8. no searching other communities');
select throws_ok(format($$ insert into public.favorites (listing_id) values (%L) $$, pg_temp.listing('Used laptop')),
  '42501', null, '8. nor saving their listings');

-- =========================================================================
-- 9. Out of stock and suspended sellers
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select public.set_listing_stock(%L, 0) $$, pg_temp.listing('Used laptop')), '9. sold out');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select * from pg_temp.search('A', 'laptop', true) $$, '9. "in stock only" hides it');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ update public.seller_profiles set status = 'suspended' where id = %L $$, pg_temp.seller('carol', 'A')),
  '9. a manager suspends a seller');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select * from pg_temp.search('A', 'laptop') $$, '9. a suspended seller''s listings disappear');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ update public.seller_profiles set status = 'active' where id = %L $$, pg_temp.seller('carol', 'A')),
  '42501', null, '9. she cannot lift her own suspension');
select throws_ok(format($$ insert into public.listings (community_id, seller_profile_id, kind, category_id, title, condition, price_minor, fulfillment)
  values (%L, %L, 'product', %L, 'While suspended', 'new', 1, '{pickup}') $$, pg_temp.fx('A'), pg_temp.seller('carol', 'A'), pg_temp.cat('electronics')),
  '42501', null, '9. nor list anything new');

select * from finish();
rollback;

-- Migration 31: members send alerts (not emergencies), with an optional location and a private photo; removal stays with managers.
begin;
create extension if not exists pgtap with schema extensions;

select plan(32);

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


-- The storage schema refuses SQL deletes unless asked (tests only).
select set_config('storage.allow_delete_query', 'true', true);

-- Helpers (owner, before any login).
create function pg_temp.img(p_community text, p_user text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_community)::text || '/' || pg_temp.fx(p_user)::text || '/' || p_file
$$;
create function pg_temp.upload(p_name text) returns void language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values ('alert-images', p_name, '{"size": 1000, "mimetype": "image/jpeg"}');
end;
$$;
create function pg_temp.alert_of(p_title text) returns uuid language sql security definer as $$
  select id from public.alerts where title = p_title
$$;

select is((select public from storage.buckets where id = 'alert-images'), false, 'the alert-images bucket is private');

-- =========================================================================
-- 1. Members and Moderators may send alerts (not emergencies)
-- =========================================================================
select is(
  (select count(*)::int from public.roles r
   where r.is_system_role and r.name in ('Member', 'Moderator')
     and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
                     where rp.role_id = r.id and p.key = 'alerts.create')),
  0, '1. every Member and Moderator system role holds alerts.create');
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'alerts.create'), '1. a Member holds alerts.create');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'alerts.manage'), '1. ...but not alerts.manage');
select lives_ok(
  format($$ insert into public.alerts (community_id, title, body, severity, status, latitude, longitude, location_accuracy_m)
            values (%L, 'Break-in on Elm St', 'Someone forced a door', 'urgent', 'published', 51.50135, -0.14189, 12) $$, pg_temp.fx('A')),
  '1. a Member sends an urgent alert at once, with her location');
select results_eq(
  $$ select status, created_by, latitude, longitude, location_accuracy_m from public.alerts where title = 'Break-in on Elm St' $$,
  format($$ values ('published', %L::uuid, 51.50135::double precision, -0.14189::double precision, 12::real) $$, pg_temp.fx('carol')),
  '1. the alert is published with the shared position');
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity, status) values (%L, 'x', 'y', 'emergency', 'published') $$, pg_temp.fx('A')),
  '42501', null, '1. emergency alerts still need alerts.manage');
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body) values (%L, 'x', 'y') $$, pg_temp.fx('B')),
  '42501', null, '1. not in a community where you are not a member');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body) values (%L, 'x', 'y') $$, pg_temp.fx('A')),
  '42501', null, '1. a pending member cannot send alerts');
reset role;
select is((select count(*)::int from public.notifications where community_id = pg_temp.fx('A') and type = 'alert'
           and title like '%Break-in%'), 3, '1. every other active member is notified (alice, erin, dave), not the sender');

-- =========================================================================
-- 2. Location: complete, in range, set only at creation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, latitude) values (%L, 'x', 'y', 10) $$, pg_temp.fx('A')),
  '23514', null, '2. a latitude without a longitude is refused');
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, latitude, longitude) values (%L, 'x', 'y', 91, 0) $$, pg_temp.fx('A')),
  '23514', null, '2. out-of-range coordinates are refused');
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, location_accuracy_m) values (%L, 'x', 'y', 5) $$, pg_temp.fx('A')),
  '23514', null, '2. an accuracy without a position is refused');
select throws_ok(
  format($$ update public.alerts set latitude = 0, longitude = 0 where id = %L $$, pg_temp.alert_of('Break-in on Elm St')),
  '42501', null, '2. the position cannot be changed afterwards');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty(
  format($$ select latitude from public.alerts where id = %L $$, pg_temp.alert_of('Break-in on Elm St')),
  '2. people outside the community never see the position');
select pg_temp.login(pg_temp.fx('dave'));
select is((select latitude from public.alerts where title = 'Break-in on Elm St'), 51.50135::double precision,
  '2. members of the community see it with the alert');

-- =========================================================================
-- 3. Photo: own folder, own alert, set only at creation, private
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '3. a Member uploads a photo into her own folder');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'dave', '22222222-2222-4222-8222-222222222222.jpg')),
  '42501', null, '3. nobody uploads into someone else''s folder');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('B', 'carol', '33333333-3333-4333-8333-333333333333.jpg')),
  '42501', null, '3. nor into a community they do not belong to');
select lives_ok(
  format($$ insert into public.alerts (community_id, title, body, severity, status, image_path) values (%L, 'Fallen tree', 'Blocking Oak Rd', 'warning', 'published', %L) $$,
    pg_temp.fx('A'), pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '3. she sends an alert with that photo');
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, image_path) values (%L, 'x', 'y', %L) $$,
    pg_temp.fx('A'), pg_temp.img('A', 'carol', '44444444-4444-4444-8444-444444444444.jpg')),
  '22023', null, '3. a photo that was never uploaded is refused');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'dave', '55555555-5555-4555-8555-555555555555.jpg')),
  '3. a Moderator uploads too');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, image_path) values (%L, 'x', 'y', %L) $$,
    pg_temp.fx('A'), pg_temp.img('A', 'dave', '55555555-5555-4555-8555-555555555555.jpg')),
  '42501', null, '3. nobody attaches someone else''s photo');
select throws_ok(
  format($$ update public.alerts set image_path = null where id = %L $$, pg_temp.alert_of('Fallen tree')),
  '42501', null, '3. the photo cannot be removed or swapped afterwards');
select is_empty(
  format($$ delete from storage.objects where bucket_id = 'alert-images' and name = %L returning 1 $$,
    pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '3. a photo in use cannot be deleted');
select pg_temp.login(pg_temp.fx('erin'));
select isnt_empty(
  format($$ select 1 from storage.objects where bucket_id = 'alert-images' and name = %L $$,
    pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '3. members who can see the alert can read its photo');
select is_empty(
  format($$ select 1 from storage.objects where bucket_id = 'alert-images' and name = %L $$,
    pg_temp.img('A', 'dave', '55555555-5555-4555-8555-555555555555.jpg')),
  '3. an unused upload is visible to its uploader only');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty(
  format($$ select 1 from storage.objects where bucket_id = 'alert-images' and name = %L $$,
    pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '3. outsiders cannot read the photo');
select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty(
  format($$ delete from storage.objects where bucket_id = 'alert-images' and name = %L returning 1 $$,
    pg_temp.img('A', 'dave', '55555555-5555-4555-8555-555555555555.jpg')),
  '3. an unused upload can be removed by its uploader (failed send cleanup)');

-- =========================================================================
-- 4. Taking alerts down is still for managers (migration 30)
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ update public.alerts set status = 'cancelled' where id = %L $$, pg_temp.alert_of('Fallen tree')),
  '42501', null, '4. a Member cannot cancel her own published alert');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty(
  format($$ update public.alerts set status = 'cancelled' where id = %L returning 1 $$, pg_temp.alert_of('Fallen tree')),
  '4. nor can another member');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(
  format($$ update public.alerts set status = 'cancelled', cancellation_reason = 'Cleared' where id = %L $$, pg_temp.alert_of('Fallen tree')),
  '4. an Admin cancels it');

select * from finish();
rollback;

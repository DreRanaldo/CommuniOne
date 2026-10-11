-- Stage 2: profile creation, de-duplication, normalisation, own-profile updates and the platform-admin path.
begin;
create extension if not exists pgtap with schema extensions;

select plan(26);

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

-- Profile creation ------------------------------------------------------------
select is_empty(
  $$ select u.id from auth.users u left join public.profiles p on p.id = u.id where p.id is null $$,
  'every auth user has a profile'
);

insert into auth.users (id, email, raw_user_meta_data) values
  ('78787878-0000-4000-8000-000000000011', 'jo@example.test',
   jsonb_build_object('first_name', '  Jo  ', 'last_name', '', 'display_name', '  Jo D ',
                      'avatar_url', 'javascript:alert(1)'));
select results_eq(
  $$ select first_name, last_name, display_name, avatar_url from public.profiles
     where id = '78787878-0000-4000-8000-000000000011' $$,
  $$ values ('Jo'::text, null::text, 'Jo D'::text, null::text) $$,
  'sign-up metadata is trimmed, blanks become NULL and unsafe avatar URLs are dropped'
);

insert into auth.users (id, email, raw_user_meta_data) values
  ('90909090-0000-4000-8000-000000000012', 'kim@example.test',
   jsonb_build_object('name', 'Kim', 'avatar_url', 'https://cdn.example.test/kim.png'));
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = '90909090-0000-4000-8000-000000000012' $$,
  $$ values ('Kim'::text, 'https://cdn.example.test/kim.png'::text) $$,
  'OAuth-style metadata (name, https avatar) populates the profile'
);

-- Profiles are never duplicated ---------------------------------------------------
select is((select count(*)::int from public.profiles where id = '90909090-0000-4000-8000-000000000012'), 1, 'exactly one profile per user');
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;
select is((select count(*)::int from public.profiles), (select count(*)::int from auth.users), 're-running the backfill creates no duplicates');
select throws_ok(
  $$ insert into public.profiles (id) values ('90909090-0000-4000-8000-000000000012') $$,
  '23505', null, 'a second profile for the same user is rejected'
);
update auth.users set raw_user_meta_data = '{"display_name": "Changed"}' where id = '90909090-0000-4000-8000-000000000012';
select is(
  (select display_name from public.profiles where id = '90909090-0000-4000-8000-000000000012'), 'Kim',
  'later auth metadata changes do not overwrite the user-owned profile'
);

-- Own profile updates ---------------------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
update public.profiles set display_name = '  Carol  ', bio = '   ' where id = pg_temp.fx('carol');
select results_eq(
  $$ select display_name, bio from public.profiles where id = pg_temp.fx('carol') $$,
  $$ values ('Carol'::text, null::text) $$,
  'own profile update is normalised (trimmed, blank -> NULL)'
);
select throws_ok(
  format($$ update public.profiles set avatar_url = 'http://insecure.example.test/a.png' where id = %L $$, pg_temp.fx('carol')),
  '23514', null, 'non-https avatar URLs are rejected'
);
select lives_ok(
  format($$ update public.profiles set avatar_url = 'https://cdn.example.test/c.png' where id = %L $$, pg_temp.fx('carol')),
  'https avatar URLs are accepted'
);

-- Community permissions never grant profile edits ------------------------------------
select pg_temp.login(pg_temp.fx('alice'));
with u as (update public.profiles set display_name = 'Renamed by owner' where id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 0, 'a community Owner cannot edit a member''s profile') from u;
select throws_ok(
  format($$ select public.admin_set_account_status(%L, 'suspended') $$, pg_temp.fx('carol')),
  '42501', 'platform administrator privileges required', 'a community Owner cannot change account status'
);

-- Platform administrators -----------------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.platform_admins (user_id) values (%L) $$, pg_temp.fx('carol')),
  '42501', null, 'users cannot make themselves platform admins'
);
select throws_ok($$ select * from public.platform_admins $$, '42501', null, 'users cannot read the platform admin list');

reset role;
insert into public.platform_admins (user_id) values (pg_temp.fx('bob'));

select pg_temp.login(pg_temp.fx('bob'));
select isnt_empty($$ select 1 from public.profiles where id = pg_temp.fx('carol') $$, 'platform admin can read profiles outside his communities');
with u as (update public.profiles set display_name = 'Carol (verified)' where id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 1, 'platform admin can update another user''s profile') from u;
select throws_ok(
  format($$ update public.profiles set status = 'suspended' where id = %L $$, pg_temp.fx('carol')),
  '42501', null, 'even platform admins cannot write status directly'
);
select results_eq(
  format($$ select status from public.admin_set_account_status(%L, 'suspended') $$, pg_temp.fx('carol')),
  $$ values ('suspended') $$,
  'platform admin suspends an account'
);
select throws_ok(
  format($$ select public.admin_set_account_status(%L, 'banned') $$, pg_temp.fx('carol')),
  '22023', null, 'invalid account statuses are rejected'
);
select throws_ok(
  format($$ select public.admin_set_account_status(%L, 'suspended') $$, pg_temp.fx('bob')),
  '42501', 'administrators cannot change their own account status', 'admins cannot change their own status'
);
select throws_ok(
  $$ select public.admin_set_account_status(gen_random_uuid(), 'suspended') $$,
  'P0002', null, 'unknown users are reported'
);

select pg_temp.login(pg_temp.fx('carol'));
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'the suspended account immediately loses access');

select pg_temp.login(pg_temp.fx('bob'));
select results_eq(
  format($$ select status from public.admin_set_account_status(%L, 'active') $$, pg_temp.fx('carol')),
  $$ values ('active') $$,
  'platform admin reactivates the account'
);
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'the reactivated account regains access');

-- A suspended platform admin is no longer an admin ----------------------------------
reset role;
update public.profiles set status = 'suspended' where id = pg_temp.fx('bob');
select pg_temp.login(pg_temp.fx('bob'));
with u as (update public.profiles set display_name = 'x' where id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 0, 'a suspended platform admin loses admin powers') from u;

-- Unauthenticated access ---------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  format($$ select public.admin_set_account_status(%L, 'suspended') $$, pg_temp.fx('carol')),
  '42501', null, 'anon cannot call admin_set_account_status'
);

select * from finish();
rollback;

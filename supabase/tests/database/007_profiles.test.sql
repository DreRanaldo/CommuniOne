-- Profile creation, ownership and community-scoped visibility.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

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

-- Profiles are created automatically at sign-up ------------------------------
select is((select count(*)::int from public.profiles where id in (select id from fx where key not like '%@%' and length(key) > 1)), 7, 'every fixture user has a profile');

insert into auth.users (id, email, raw_user_meta_data) values
  ('34343434-0000-4000-8000-000000000009', 'ivy@example.test',
   jsonb_build_object('full_name', 'Ivy Example', 'first_name', repeat('x', 500)));
select results_eq(
  $$ select display_name, char_length(first_name) from public.profiles where id = '34343434-0000-4000-8000-000000000009' $$,
  $$ values ('Ivy Example', 100) $$,
  'sign-up metadata populates the profile and over-long values never block sign-up'
);

-- Own profile -----------------------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select results_eq($$ select id from public.profiles where id = auth.uid() $$, $$ select pg_temp.fx('carol') $$, 'user can read her own profile');

with u as (update public.profiles set display_name = 'Carol C', bio = 'Hi' where id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 1, 'user can update her own profile') from u;

select throws_ok(
  format($$ update public.profiles set status = 'active' where id = %L $$, pg_temp.fx('carol')),
  '42501', null, 'user cannot change her own account status'
);
select throws_ok(
  $$ insert into public.profile_private (phone) values ('call me') $$,
  '23514', null, 'phone format is validated'
);
select throws_ok(
  $$ insert into public.profiles (id) values ('56565656-0000-4000-8000-000000000010') $$,
  '42501', null, 'clients cannot insert profiles'
);
select throws_ok(
  format($$ delete from public.profiles where id = %L $$, pg_temp.fx('carol')),
  '42501', null, 'clients cannot delete profiles'
);

-- Other users' profiles ---------------------------------------------------------
with u as (update public.profiles set display_name = 'hacked' where id = pg_temp.fx('erin') returning 1)
select is(count(*)::int, 0, 'user cannot update another user''s profile') from u;
select isnt_empty($$ select 1 from public.profiles where id = pg_temp.fx('erin') $$, 'user can see a co-member''s profile');
select is_empty($$ select 1 from public.profiles where id = pg_temp.fx('frank') $$, 'user cannot see profiles of users in other communities');

select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty($$ select 1 from public.profiles where id = pg_temp.fx('frank') $$, 'multi-community user sees co-members from each community');
select isnt_empty($$ select 1 from public.profiles where id = pg_temp.fx('grace') $$, 'members can see pending applicants'' profiles');

-- Leaving a community ends profile visibility ------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
update public.memberships set status = 'left' where id = pg_temp.fx('carol@A');
select pg_temp.login(pg_temp.fx('erin'));
select is_empty($$ select 1 from public.profiles where id = pg_temp.fx('carol') $$, 'former members'' profiles are no longer visible');
select is((select display_name from public.profiles where id = pg_temp.fx('erin')), null, 'other user''s profile was not modified');

reset role;
set local role anon;
select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot read profiles');

select * from finish();
rollback;

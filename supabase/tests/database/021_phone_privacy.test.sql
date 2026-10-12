-- Pre-Stage 12: phone numbers are private to their owner.
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

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

select pg_temp.login(pg_temp.fx('carol'));
insert into public.profile_private (phone) values (' +1 555 0123 ');
select results_eq($$ select user_id, phone from public.profile_private $$, $$ values (pg_temp.fx('carol'), '+1 555 0123') $$,
  '1. a user stores and reads her own phone number');
update public.profile_private set phone = '+1 555 0456' where user_id = pg_temp.fx('carol');
select is((select phone from public.profile_private where user_id = pg_temp.fx('carol')), '+1 555 0456', '2. a user updates her own phone number');
select throws_ok(
  format($$ insert into public.profile_private (user_id, phone) values (%L, '+1 555 0000') $$, pg_temp.fx('dave')),
  '42501', null, 'nobody can set another user''s phone number'
);

select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from public.profile_private where user_id = pg_temp.fx('carol') $$, '3/4. a co-member cannot read another member''s phone number');
with u as (update public.profile_private set phone = '+1 000' where user_id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 0, 'a co-member cannot change it') from u;
select pg_temp.login(pg_temp.fx('erin'));
select is_empty($$ select 1 from public.profile_private where user_id = pg_temp.fx('carol') $$, '7. a community Admin cannot read members'' phone numbers');
select pg_temp.login(pg_temp.fx('alice'));
select is_empty($$ select 1 from public.profile_private $$, '7. nor can the community Owner');
reset role;
insert into public.platform_admins (user_id) values (pg_temp.fx('bob'));
select pg_temp.login(pg_temp.fx('bob'));
select is_empty($$ select 1 from public.profile_private where user_id = pg_temp.fx('carol') $$, '7. nor platform admins');

-- 6. Profiles, member lists and every other surface carry no phone number
reset role;
select hasnt_column('public', 'profiles', 'phone', '6. profiles (readable by co-members) have no phone column');
select is_empty(
  $$ select table_name || '.' || column_name from information_schema.columns
     where table_schema = 'public' and column_name ilike '%phone%' and table_name <> 'profile_private' $$,
  '6. no other public table or view has a phone column'
);
select is_empty(
  $$ select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (pg_get_function_result(p.oid) ilike '%phone%' or (p.prorettype = 'public.profile_private'::regtype)) $$,
  '5. no public function returns phone numbers'
);
select is_empty($$ select 1 from public.notifications where (title || coalesce(body, '') || data::text) ~ '555 04' $$, 'phone numbers never reach notifications');
select is(
  (select count(*)::int from information_schema.role_column_grants
   where table_schema = 'public' and table_name = 'profile_private' and grantee = 'anon'), 0,
  'anon has no privileges on profile_private'
);
select is_empty(
  $$ select 1 from public.permissions where key ilike '%phone%' $$,
  '7. no permission grants administrators phone access (policy: private to the user)'
);

-- Suspended users still see, but cannot change, their own number
update public.profiles set status = 'suspended' where id = pg_temp.fx('carol');
select pg_temp.login(pg_temp.fx('carol'));
select isnt_empty($$ select 1 from public.profile_private $$, 'a suspended user can still read her own phone number');
with u as (update public.profile_private set phone = '+1 555 0999' returning 1)
select is(count(*)::int, 0, 'a suspended user cannot change it') from u;

reset role;
set local role anon;
select throws_ok($$ select * from public.profile_private $$, '42501', null, 'anon cannot read phone numbers');

select * from finish();
rollback;

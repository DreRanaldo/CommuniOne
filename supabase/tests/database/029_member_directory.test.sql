-- RN-14: member directory: active members of one community, community-profile fields only, name search (scoped, literal wildcards), paging, phone privacy, isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

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

-- Names and a private phone number (as trusted setup, before any login).
update public.profiles set display_name = 'Alice Archer' where id = pg_temp.fx('alice');
update public.profiles set display_name = 'Erin E.' where id = pg_temp.fx('erin');
update public.profiles set display_name = null, first_name = 'Dave', last_name = 'Dalton', bio = 'Fixes bikes.' where id = pg_temp.fx('dave');
update public.profiles set display_name = 'Carol_100%', first_name = 'Carol' where id = pg_temp.fx('carol');
update public.profiles set display_name = 'Grace Pending' where id = pg_temp.fx('grace');
update public.profiles set display_name = 'Bob Builder' where id = pg_temp.fx('bob');
update public.profiles set display_name = 'Frank Ocean' where id = pg_temp.fx('frank');
insert into public.profile_private (user_id, phone) values (pg_temp.fx('carol'), '+1 555 0100'), (pg_temp.fx('dave'), '+1 555 0199');

create function pg_temp.names(p_community text, p_query text default null, p_limit int default 30) returns text[] language sql as $$
  select coalesce(array_agg(display_name order by n), '{}')
  from (select display_name, row_number() over () as n
        from public.list_community_members(pg_temp.fx(p_community), p_query, p_limit)) s
$$;

-- =========================================================================
-- 1. The directory: active members of this community only, by name
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select is(pg_temp.names('A'), array['Alice Archer', 'Carol_100%', 'Dave Dalton', 'Erin E.'],
  '1. active members of A, by name (the pending member and other communities'' members are not listed)');
select is((select array_agg(display_name) from public.list_community_members(pg_temp.fx('A')) where is_me),
  array['Carol_100%'], '1. the caller is marked');
select is((select role_names from public.list_community_members(pg_temp.fx('A')) where user_id = pg_temp.fx('alice')),
  array['Owner'], '1. roles are shown (roles.view)');
select is((select display_name from public.list_community_members(pg_temp.fx('A')) where user_id = pg_temp.fx('dave')),
  'Dave Dalton', '1. without a display name, first and last name are used');
select is(
  (select count(*) from pg_proc p, unnest(p.proargnames) a(name)
   where p.proname in ('list_community_members', 'get_community_member')
     and p.pronamespace = 'public'::regnamespace
     and a.name ~* '(phone|email|status|created_at|updated_at)'),
  0::bigint, '1. the functions return no phone, e-mail, account status or timestamps');

-- =========================================================================
-- 2. Search: names only, inside this community, wildcards literal
-- =========================================================================
select is(pg_temp.names('A', 'dal'), array['Dave Dalton'], '2. search matches names (here the last name)');
select is(pg_temp.names('A', '  ALICE '), array['Alice Archer'], '2. case-insensitive, trimmed');
select is(pg_temp.names('A', 'frank'), '{}'::text[], '2. another community''s member is not found');
select is(pg_temp.names('A', 'Grace'), '{}'::text[], '2. a pending member is not found');
select is(pg_temp.names('A', '%'), array['Carol_100%'], '2. % is a literal character, not a wildcard');
select is(pg_temp.names('A', '_'), array['Carol_100%'], '2. _ is a literal character, not a wildcard');
select is(pg_temp.names('A', '555'), '{}'::text[], '2. phone numbers are never searched');
select is(pg_temp.names('A', 'example.test'), '{}'::text[], '2. e-mail addresses are never searched');
select throws_ok(format($$ select * from public.list_community_members(%L, %L) $$, pg_temp.fx('A'), repeat('x', 101)),
  '22023', null, '2. search text is at most 100 characters');

-- =========================================================================
-- 3. Paging by name
-- =========================================================================
select is(pg_temp.names('A', null, 2), array['Alice Archer', 'Carol_100%'], '3. first page');
select is(
  (select array_agg(display_name order by sort_unnamed, sort_name, user_id)
   from public.list_community_members(pg_temp.fx('A'), null, 2, false, 'carol_100%', pg_temp.fx('carol'))),
  array['Dave Dalton', 'Erin E.'], '3. the next page follows the cursor');
select throws_ok(format($$ select * from public.list_community_members(%L, null, 2, null, null, %L) $$, pg_temp.fx('A'), pg_temp.fx('carol')),
  '22023', null, '3. a partial cursor is refused');

-- =========================================================================
-- 4. A member's profile
-- =========================================================================
select results_eq(
  format($$ select display_name, first_name, last_name, bio, role_names, is_me from public.get_community_member(%L, %L) $$,
    pg_temp.fx('A'), pg_temp.fx('dave')),
  $$ values ('Dave Dalton'::text, 'Dave'::text, 'Dalton'::text, 'Fixes bikes.'::text, array['Moderator']::text[], false) $$,
  '4. a co-member''s community profile');
select is((select count(*) from public.get_community_member(pg_temp.fx('A'), pg_temp.fx('frank'))), 0::bigint,
  '4. someone who is not a member of this community has no profile here');
select is((select count(*) from public.get_community_member(pg_temp.fx('A'), pg_temp.fx('grace'))), 0::bigint,
  '4. nor does a pending member');
select throws_ok(format($$ select * from public.get_community_member(%L, %L) $$, pg_temp.fx('B'), pg_temp.fx('bob')),
  '42501', null, '4. no profiles of a community you do not belong to');

-- =========================================================================
-- 5. Phone numbers stay private
-- =========================================================================
select is((select count(*) from public.profile_private), 1::bigint, '5. a member reads only their own phone row');
select is((select phone from public.profile_private), '+1 555 0100', '5. ...their own');
select pg_temp.login(pg_temp.fx('alice'));
select is((select count(*) from public.profile_private where user_id = pg_temp.fx('carol')), 0::bigint,
  '5. not even the community Owner can read a member''s phone');

-- =========================================================================
-- 6. Who may list
-- =========================================================================
select is(pg_temp.names('B'), array['Alice Archer', 'Bob Builder', 'Frank Ocean'], '6. a member of two communities sees each directory separately');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(format($$ select * from public.list_community_members(%L) $$, pg_temp.fx('A')),
  '42501', null, '6. a member of another community cannot list A');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(format($$ select * from public.list_community_members(%L) $$, pg_temp.fx('A')),
  '42501', null, '6. a pending member cannot list');
select throws_ok(format($$ select * from public.get_community_member(%L, %L) $$, pg_temp.fx('A'), pg_temp.fx('alice')),
  '42501', null, '6. ...or open profiles');
reset role;
set local role anon;
select throws_ok(format($$ select * from public.list_community_members(%L) $$, pg_temp.fx('A')),
  '42501', null, '6. signed-out clients cannot call it');
reset role;

-- =========================================================================
-- 7. Suspended members and deactivated accounts disappear
-- =========================================================================
update public.memberships set status = 'suspended' where community_id = pg_temp.fx('A') and user_id = pg_temp.fx('dave');
update public.profiles set status = 'deactivated' where id = pg_temp.fx('erin');
select pg_temp.login(pg_temp.fx('carol'));
select is(pg_temp.names('A'), array['Alice Archer', 'Carol_100%'], '7. suspended members and deactivated accounts are not listed');
select is((select count(*) from public.get_community_member(pg_temp.fx('A'), pg_temp.fx('dave'))), 0::bigint,
  '7. ...nor shown');

select * from finish();
rollback;

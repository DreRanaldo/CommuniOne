-- Stage 3: my_communities(), my_community_permissions(), status-based membership visibility, creation limit.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

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

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.memberships'::regclass and confrelid = 'public.profiles'::regclass
    and contype = 'f' and confdeltype = 'c'
), 'memberships.user_id references profiles.id (enables member-profile embedding)');

-- my_communities(): every membership of the caller, across communities ------
select pg_temp.login(pg_temp.fx('alice'));
select results_eq(
  $$ select slug, membership_status, role_names from public.my_communities() $$,
  $$ values ('community-a', 'active', array['Owner']), ('community-b', 'active', array['Member']) $$,
  'my_communities lists each community with the caller''s status and roles'
);

select pg_temp.login(pg_temp.fx('frank'));
select results_eq(
  $$ select community_id from public.my_communities() $$,
  $$ values (pg_temp.fx('B')) $$,
  'my_communities never includes communities the caller does not belong to'
);

select pg_temp.login(pg_temp.fx('grace'));
select results_eq(
  $$ select slug, membership_status, role_names from public.my_communities() $$,
  $$ values ('community-a', 'pending', '{}'::text[]) $$,
  'a pending member sees her pending membership'
);
select is_empty($$ select 1 from public.communities $$, 'a pending member cannot read the community itself');

-- my_community_permissions() ---------------------------------------------------
select pg_temp.login(pg_temp.fx('alice'));
select is((select count(*)::int from public.my_community_permissions(pg_temp.fx('A'))), 35, 'Owner has 35 permission keys in A');
select is((select count(*)::int from public.my_community_permissions(pg_temp.fx('B'))), 18, 'the same user has 18 permission keys in B');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select public.my_community_permissions(pg_temp.fx('A')) $$, 'non-members get no permission keys');
select pg_temp.login(pg_temp.fx('grace'));
select is_empty($$ select public.my_community_permissions(pg_temp.fx('A')) $$, 'pending members get no permission keys');

-- Membership visibility by status -------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select distinct status from public.memberships where community_id = pg_temp.fx('A') $$,
  $$ values ('active') $$,
  'a plain member sees only active memberships'
);
select is_empty($$ select 1 from public.memberships where id = pg_temp.fx('grace@A') $$, 'a plain member cannot see pending applications');
select is_empty($$ select 1 from public.profiles where id = pg_temp.fx('grace') $$, 'a plain member cannot see pending applicants'' profiles');
select is_empty($$ select 1 from public.membership_roles where membership_id = pg_temp.fx('grace@A') $$, 'a plain member cannot see role assignments of non-active memberships');
select is((select count(*)::int from public.memberships where community_id = pg_temp.fx('A')), 4, 'a plain member sees all four active members');

select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty($$ select 1 from public.memberships where id = pg_temp.fx('grace@A') $$, 'a moderator (members.suspend) sees pending applications');
select isnt_empty($$ select 1 from public.profiles where id = pg_temp.fx('grace') $$, 'a moderator sees pending applicants'' profiles');

-- Suspended and departed members ---------------------------------------------------
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select membership_status from public.my_communities() $$,
  $$ values ('suspended') $$,
  'a suspended member still sees her membership and its status'
);
select is_empty($$ select public.my_community_permissions(pg_temp.fx('A')) $$, 'a suspended member has no permissions');
select results_eq(
  $$ select id from public.memberships $$,
  $$ values (pg_temp.fx('carol@A')) $$,
  'a suspended member sees only her own membership'
);
select pg_temp.login(pg_temp.fx('erin'));
select isnt_empty($$ select 1 from public.memberships where id = pg_temp.fx('carol@A') $$, 'an admin sees suspended memberships');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.memberships where community_id = pg_temp.fx('A') $$, 'other communities never see the suspension');

select pg_temp.login(pg_temp.fx('carol'));
update public.memberships set status = 'left' where id = pg_temp.fx('carol@A');
select is_empty($$ select public.my_communities() $$, 'a departed membership disappears from my_communities');

-- Role lifecycle on membership transitions -------------------------------------
reset role;
select is(
  (select count(*)::int from public.roles where community_id = pg_temp.fx('A') and is_default_for_new_members), 1,
  'each community has exactly one default role for new members'
);

select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'active' where id = pg_temp.fx('grace@A');
select pg_temp.login(pg_temp.fx('grace'));
select results_eq(
  $$ select role_names from public.my_communities() $$,
  $$ values (array['Member']) $$,
  'an approved applicant receives the default role'
);
select ok(public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'an approved applicant can use the community');

select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'suspended' where id = pg_temp.fx('erin@A');
reset role;
select results_eq(
  $$ select r.name from public.membership_roles mr join public.roles r on r.id = mr.role_id where mr.membership_id = pg_temp.fx('erin@A') $$,
  $$ values ('Admin') $$,
  'suspension keeps role assignments'
);
select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'active' where id = pg_temp.fx('erin@A');

select pg_temp.login(pg_temp.fx('erin'));
update public.memberships set status = 'left' where id = pg_temp.fx('erin@A');
reset role;
select is_empty($$ select 1 from public.membership_roles where membership_id = pg_temp.fx('erin@A') $$, 'leaving removes all role assignments');
select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'active' where id = pg_temp.fx('erin@A');
select pg_temp.login(pg_temp.fx('erin'));
select results_eq(
  $$ select role_names from public.my_communities() where community_id = pg_temp.fx('A') $$,
  $$ values (array['Member']) $$,
  're-admission grants the default role, not the previous Admin role'
);
select ok(not public.has_community_permission(pg_temp.fx('A'), 'members.remove'), 'a re-admitted former admin has no admin permissions');

reset role;
insert into auth.users (id, email) values ('13131313-0000-4000-8000-000000000013', 'liam@example.test');
insert into fx values ('liam', '13131313-0000-4000-8000-000000000013');
select pg_temp.add_member('A', 'liam', 'Moderator', 'pending');
select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'rejected' where id = pg_temp.fx('liam@A');
reset role;
select is_empty($$ select 1 from public.membership_roles where membership_id = pg_temp.fx('liam@A') $$, 'rejection removes role assignments');

-- Community settings size cap --------------------------------------------------------
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok(
  format($$ update public.communities set settings = jsonb_build_object('blob', repeat('x', 20000)) where id = %L $$, pg_temp.fx('A')),
  '23514', null, 'community settings are capped in size'
);
with u as (update public.communities set settings = '{"theme": "green"}' where id = pg_temp.fx('A') returning settings)
select is((select settings ->> 'theme' from u), 'green', 'normal settings updates still work');

-- Community creation limit ---------------------------------------------------------------
select lives_ok(
  $$ select public.create_community('Limit ' || i, 'limit-' || i) from generate_series(1, 9) as i $$,
  'a user can create up to 10 communities in 24 hours'
);
select throws_ok(
  $$ select public.create_community('One too many', 'limit-11') $$,
  '53400', null, 'the 11th community within 24 hours is refused'
);
select pg_temp.login(pg_temp.fx('bob'));
select lives_ok($$ select public.create_community('Bob 2', 'bob-two') $$, 'the limit is per user');

-- Unauthenticated --------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$ select * from public.my_communities() $$, '42501', null, 'anon cannot call my_communities');
select throws_ok(
  format($$ select * from public.my_community_permissions(%L) $$, pg_temp.fx('A')),
  '42501', null, 'anon cannot call my_community_permissions'
);

select * from finish();
rollback;

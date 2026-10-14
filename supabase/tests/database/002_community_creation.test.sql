-- Community creation, Owner assignment, multiple communities with different roles.
begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

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

-- 1. User can create a community -------------------------------------------
select is(
  (select created_by from public.communities where id = pg_temp.fx('A')),
  pg_temp.fx('alice'), 'community A was created with created_by = creator'
);

select results_eq(
  $$ select name, is_system_role from public.roles where community_id = pg_temp.fx('A') order by name $$,
  $$ values ('Admin', true), ('Member', true), ('Moderator', true), ('Owner', true) $$,
  'default system roles are created for the new community'
);

select results_eq(
  $$ select r.name, count(rp.permission_id)::int
     from public.roles r left join public.role_permissions rp on rp.role_id = r.id
     where r.community_id = pg_temp.fx('A') group by r.name order by r.name $$,
  $$ values ('Admin', 34), ('Member', 18), ('Moderator', 21), ('Owner', 35) $$,
  'role permissions are copied from the templates'
);

-- 2. Community creator becomes Owner ----------------------------------------
select results_eq(
  $$ select m.status, (m.joined_at is not null) from public.memberships m where m.id = pg_temp.fx('alice@A') $$,
  $$ values ('active', true) $$,
  'creator has an active membership with joined_at set'
);

select results_eq(
  $$ select r.name from public.membership_roles mr join public.roles r on r.id = mr.role_id
     where mr.membership_id = pg_temp.fx('alice@A') $$,
  $$ values ('Owner') $$,
  'creator holds exactly the Owner role'
);

select pg_temp.login(pg_temp.fx('alice'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'roles.manage'), 'creator can manage roles');
select ok(public.has_community_permission(pg_temp.fx('A'), 'community.update'), 'creator can update the community');

select results_eq(
  $$ select name, slug, community_type from public.create_community('  My Club ', 'My-Club', 'club', 'desc', 'America/New_York') $$,
  $$ values ('My Club', 'my-club', 'club') $$,
  'create_community trims the name and normalises the slug'
);

-- Validation ------------------------------------------------------------------
select throws_ok($$ select public.create_community('Dup', 'community-a') $$, '23505', null, 'slugs are globally unique');
select throws_ok($$ select public.create_community('Bad', 'bad slug!') $$, '23514', null, 'slug format is enforced');
select throws_ok($$ select public.create_community('Bad', 'bad-type', 'castle') $$, '23514', null, 'community_type is constrained');
select throws_ok($$ select public.create_community('Bad', 'bad-tz', 'club', null, 'Mars/Olympus') $$, '22023', null, 'timezone must be a valid IANA zone');
select throws_ok(
  $$ insert into public.communities (name, slug) values ('Direct', 'direct-insert') $$,
  '42501', null, 'clients cannot insert communities directly'
);

-- 3 & 4. Multiple communities, different roles in each ------------------------
select results_eq(
  $$ select c.slug, r.name
     from public.memberships m
     join public.communities c on c.id = m.community_id
     join public.membership_roles mr on mr.membership_id = m.id
     join public.roles r on r.id = mr.role_id
     where m.user_id = pg_temp.fx('alice') and c.slug in ('community-a', 'community-b', 'my-club')
     order by c.slug $$,
  $$ values ('community-a', 'Owner'), ('community-b', 'Member'), ('my-club', 'Owner') $$,
  'alice belongs to three communities with different roles'
);

select ok(public.has_community_permission(pg_temp.fx('A'), 'members.remove'), 'alice can remove members in A (Owner)');
select ok(not public.has_community_permission(pg_temp.fx('B'), 'members.remove'), 'alice cannot remove members in B (Member)');
select ok(public.has_community_permission(pg_temp.fx('B'), 'posts.create'), 'alice can post in B (Member)');

-- Authentication is required --------------------------------------------------
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.create_community('Anon', 'anon-community') $$, '42501', 'authentication required', 'create_community requires an authenticated user');
reset role;
set local role anon;
select throws_ok($$ select public.create_community('Anon', 'anon-community-2') $$, '42501', null, 'anon role cannot execute create_community');
reset role;

-- Atomicity: a failure part-way through leaves nothing behind ----------------
update public.role_templates set assign_to_creator = false;
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select public.create_community('Half', 'half-built') $$, 'P0001', null, 'create_community fails without a creator template');
reset role;
select is_empty($$ select 1 from public.communities where slug = 'half-built' $$, 'failed creation leaves no community behind');
select is_empty($$ select 1 from public.memberships where user_id = pg_temp.fx('carol') and community_id not in (pg_temp.fx('A')) $$, 'failed creation leaves no membership behind');

select * from finish();
rollback;

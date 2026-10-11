-- Custom roles, role permissions, assignments and system-role protection.
begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

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

-- 9. Owner can manage roles ---------------------------------------------------
select pg_temp.login(pg_temp.fx('alice'));

select lives_ok(
  format($$ insert into public.roles (community_id, name, description) values (%L, 'Treasurer', 'Handles finances') $$, pg_temp.fx('A')),
  'owner creates a custom role'
);
select is(
  (select is_system_role from public.roles where id = pg_temp.role_id('A', 'Treasurer')), false,
  'custom roles are not system roles'
);
select lives_ok(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key in ('documents.manage', 'documents.upload') $$,
         pg_temp.role_id('A', 'Treasurer')),
  'owner grants permissions to the custom role'
);
select lives_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Treasurer')),
  'owner assigns the custom role'
);

select pg_temp.login(pg_temp.fx('carol'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'documents.manage'), 'assignee gains the role''s permissions');
select ok(public.has_community_permission(pg_temp.fx('A'), 'posts.create'), 'permissions from multiple roles are combined');
select ok(not public.has_community_permission(pg_temp.fx('B'), 'documents.manage'), 'a role in A grants nothing in B');

select pg_temp.login(pg_temp.fx('alice'));

-- 12. Duplicate role assignment is prevented -------------------------------------
select throws_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Treasurer')),
  '23505', null, 'duplicate role assignment is rejected'
);
select throws_ok(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'documents.manage' $$, pg_temp.role_id('A', 'Treasurer')),
  '23505', null, 'duplicate role permission is rejected'
);
select throws_ok(
  format($$ insert into public.roles (community_id, name) values (%L, 'TREASURER') $$, pg_temp.fx('A')),
  '23505', null, 'role names are unique per community (case-insensitive)'
);

with u as (update public.roles set name = 'Finance' where id = pg_temp.role_id('A', 'Treasurer') returning 1)
select is(count(*)::int, 1, 'owner renames a custom role') from u;

-- System roles are protected ----------------------------------------------------
with u as (update public.roles set name = 'Boss' where id = pg_temp.role_id('A', 'Owner') returning 1)
select is(count(*)::int, 0, 'system roles cannot be modified by clients') from u;
with d as (delete from public.roles where id = pg_temp.role_id('A', 'Member') returning 1)
select is(count(*)::int, 0, 'system roles cannot be deleted by clients') from d;
select throws_like(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'audit.view' $$, pg_temp.role_id('A', 'Member')),
  '%row-level security%', 'system role permissions cannot be changed by clients'
);
select throws_ok(
  format($$ insert into public.roles (community_id, name, is_system_role) values (%L, 'Fake System', true) $$, pg_temp.fx('A')),
  '42501', null, 'clients cannot create system roles'
);

-- Role reassignment and deletion ----------------------------------------------
select throws_ok(
  format($$ delete from public.roles where id = %L $$, pg_temp.role_id('A', 'Finance')),
  '23503', null, 'an assigned role cannot be deleted (RESTRICT)'
);
with d as (delete from public.membership_roles where membership_id = pg_temp.fx('carol@A') and role_id = pg_temp.role_id('A', 'Finance') returning 1)
select is(count(*)::int, 1, 'owner unassigns a role') from d;
with d as (delete from public.role_permissions where role_id = pg_temp.role_id('A', 'Finance') and permission_id = (select id from public.permissions where key = 'documents.upload') returning 1)
select is(count(*)::int, 1, 'owner removes a permission from a custom role') from d;
with d as (delete from public.roles where name = 'Finance' and community_id = pg_temp.fx('A') returning 1)
select is(count(*)::int, 1, 'owner deletes an unassigned custom role') from d;
reset role;
select is_empty(
  $$ select 1 from public.role_permissions rp left join public.roles r on r.id = rp.role_id where r.id is null $$,
  'deleting a role removes its permission grants'
);

select pg_temp.login(pg_temp.fx('alice'));
select lives_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Moderator')),
  'owner promotes a member to moderator'
);
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'posts.moderate'), 'promoted member gains moderation permissions');

-- Admin can view but not manage roles -----------------------------------------
select pg_temp.login(pg_temp.fx('erin'));
select is((select count(*)::int from public.roles where community_id = pg_temp.fx('A')), 4, 'admin can view roles');
select throws_like(
  format($$ insert into public.roles (community_id, name) values (%L, 'Admin 2') $$, pg_temp.fx('A')),
  '%row-level security%', 'admin cannot create roles (no roles.manage)'
);

select * from finish();
rollback;

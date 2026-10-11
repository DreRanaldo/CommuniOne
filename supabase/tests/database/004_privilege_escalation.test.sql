-- Members and delegated managers cannot grant themselves roles or permissions.
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

-- carol: plain Member of A ---------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));

select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Owner')),
  '%row-level security%', 'member cannot grant herself Owner'
);
select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Moderator')),
  '%row-level security%', 'member cannot grant herself Moderator'
);
select throws_like(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'roles.manage' $$, pg_temp.role_id('A', 'Member')),
  '%row-level security%', 'member cannot add permissions to her own role'
);
select throws_like(
  format($$ insert into public.roles (community_id, name) values (%L, 'Super Member') $$, pg_temp.fx('A')),
  '%row-level security%', 'member cannot create roles'
);
with u as (update public.roles set name = 'Owner2' where id = pg_temp.role_id('A', 'Member') returning 1)
select is(count(*)::int, 0, 'member cannot modify roles') from u;
select throws_ok(
  format($$ update public.roles set is_system_role = false where id = %L $$, pg_temp.role_id('A', 'Owner')),
  '42501', null, 'is_system_role is not writable by clients'
);
with u as (update public.memberships set status = 'active' where id = pg_temp.fx('grace@A') returning 1)
select is(count(*)::int, 0, 'member cannot approve pending memberships') from u;
with u as (update public.communities set name = 'Carolville' where id = pg_temp.fx('A') returning 1)
select is(count(*)::int, 0, 'member cannot update the community') from u;
select throws_ok(
  format($$ update public.memberships set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('carol@A')),
  '42501', null, 'member cannot move her membership to another community'
);
select throws_ok(
  format($$ update public.memberships set status = 'suspended' where id = %L $$, pg_temp.fx('carol@A')),
  '42501', null, 'member cannot change her own status except to left'
);
select throws_ok(
  format($$ insert into public.memberships (community_id, user_id, status) values (%L, %L, 'active') $$,
         pg_temp.fx('B'), pg_temp.fx('carol')),
  '42501', null, 'user cannot insert herself into another community'
);
select ok(not public.has_community_permission(pg_temp.fx('A'), 'roles.manage'), 'member still lacks roles.manage after all attempts');

-- erin: Admin (everything except roles.manage) ---------------------------------
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('erin@A'), pg_temp.role_id('A', 'Owner')),
  '%row-level security%', 'admin cannot grant herself Owner'
);
select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Moderator')),
  '%row-level security%', 'admin without roles.manage cannot assign roles'
);
select throws_like(
  format($$ update public.memberships set status = 'suspended' where id = %L $$, pg_temp.fx('alice@A')),
  '%insufficient privileges%', 'admin cannot suspend the owner'
);
with d as (delete from public.memberships where id = pg_temp.fx('alice@A') returning 1)
select is(count(*)::int, 0, 'admin cannot remove the owner') from d;

-- dave: Moderator ---------------------------------------------------------------
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.memberships set status = 'suspended' where id = %L $$, pg_temp.fx('erin@A')),
  '%insufficient privileges%', 'moderator cannot suspend an admin'
);

-- alice: Owner — even owners cannot change their own role assignments --------
select pg_temp.login(pg_temp.fx('alice'));
select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('alice@A'), pg_temp.role_id('A', 'Admin')),
  '%row-level security%', 'nobody can modify their own role assignments'
);

-- Delegated role manager cannot escalate beyond what they hold ---------------
-- alice creates a custom "Role Manager" role (roles.manage + Moderator perms)
-- and gives it to dave (Moderator).
select lives_ok(
  format($$ insert into public.roles (community_id, name) values (%L, 'Role Manager') $$, pg_temp.fx('A')),
  'owner creates a custom role'
);
select lives_ok(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'roles.manage' $$, pg_temp.role_id('A', 'Role Manager')),
  'owner grants roles.manage to the custom role'
);
select lives_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('dave@A'), pg_temp.role_id('A', 'Role Manager')),
  'owner assigns the custom role to the moderator'
);

select pg_temp.login(pg_temp.fx('dave'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'roles.manage'), 'dave now holds roles.manage');
select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Admin')),
  '%row-level security%', 'delegated role manager cannot grant a role with permissions he lacks'
);
select throws_like(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'audit.view' $$, pg_temp.role_id('A', 'Role Manager')),
  '%row-level security%', 'delegated role manager cannot add a permission he lacks to his own role'
);
with d as (delete from public.membership_roles where membership_id = pg_temp.fx('erin@A') returning 1)
select is(count(*)::int, 0, 'delegated role manager cannot strip roles from a more privileged member') from d;
select lives_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Moderator')),
  'delegated role manager can grant a role within his own permissions'
);

select * from finish();
rollback;

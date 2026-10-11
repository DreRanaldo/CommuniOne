-- Cross-tenant isolation between Community A and Community B.
begin;
create extension if not exists pgtap with schema extensions;

select plan(21);

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

-- frank: Member of B only. bob: Owner of B only. Neither belongs to A.
select pg_temp.login(pg_temp.fx('frank'));

select results_eq($$ select id from public.communities $$, $$ select pg_temp.fx('B') $$, 'frank sees only community B');
select is_empty($$ select 1 from public.communities where id = pg_temp.fx('A') $$, 'frank cannot read community A by its UUID');
select is_empty($$ select 1 from public.memberships where community_id = pg_temp.fx('A') $$, 'frank cannot read A memberships');
select is_empty($$ select 1 from public.roles where community_id = pg_temp.fx('A') $$, 'frank cannot read A roles');
select is_empty($$ select 1 from public.membership_roles where community_id = pg_temp.fx('A') $$, 'frank cannot read A role assignments');
select is_empty(
  $$ select 1 from public.role_permissions where role_id = pg_temp.role_id('A', 'Owner') $$,
  'frank cannot read A role permissions'
);
select is_empty($$ select 1 from public.profiles where id = pg_temp.fx('carol') $$, 'frank cannot read profiles of A-only members');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'frank has no permissions in A');

-- bob owns B; owning one community grants nothing in another.
select pg_temp.login(pg_temp.fx('bob'));
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'owner of B has no permissions in A');

with u as (update public.communities set name = 'pwned' where id = pg_temp.fx('A') returning 1)
select is(count(*)::int, 0, 'owner of B cannot update community A') from u;

with u as (update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 0, 'owner of B cannot suspend members of A') from u;

with d as (delete from public.memberships where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 0, 'owner of B cannot remove members of A') from d;

select throws_like(
  format($$ insert into public.roles (community_id, name) values (%L, 'Intruder') $$, pg_temp.fx('A')),
  '%row-level security%', 'owner of B cannot create roles in A'
);

select throws_ok(
  format($$ insert into public.role_permissions (role_id, permission_id)
            select %L, id from public.permissions where key = 'audit.view' $$, pg_temp.role_id('A', 'Member')),
  '42501', null, 'owner of B cannot change role permissions in A'
);

select throws_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('frank@B'), pg_temp.role_id('A', 'Owner')),
  '42501', null, 'owner of B cannot attach an A role to a B membership'
);

select throws_like(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('B', 'Owner')),
  '%row-level security%', 'owner of B cannot attach a B role to an A membership'
);

-- alice is Owner in A but only Member in B: her A powers do not carry over.
select pg_temp.login(pg_temp.fx('alice'));
with u as (update public.communities set name = 'renamed' where id = pg_temp.fx('B') returning 1)
select is(count(*)::int, 0, 'Owner of A cannot update B where she is only a Member') from u;
with u as (update public.memberships set status = 'suspended' where id = pg_temp.fx('frank@B') returning 1)
select is(count(*)::int, 0, 'Owner of A cannot suspend members of B') from u;
select results_eq(
  $$ select id from public.communities order by name $$,
  $$ values (pg_temp.fx('A')), (pg_temp.fx('B')) $$,
  'a multi-community user sees exactly her own communities'
);

-- Constraint-level guarantee, even for trusted server-side code ---------------
reset role;
select throws_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('carol@A'), pg_temp.role_id('B', 'Member')),
  '23503', null, 'composite FK rejects a role from another community even for privileged writes'
);

select is(
  (select name from public.communities where id = pg_temp.fx('A')), 'Community A',
  'community A is unchanged after all cross-tenant attempts'
);

select * from finish();
rollback;

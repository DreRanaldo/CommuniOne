-- Membership lifecycle: approve, suspend, reinstate, reject, remove, leave.
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

-- 8. Owner can manage community membership -----------------------------------
select pg_temp.login(pg_temp.fx('alice'));

with u as (update public.memberships set status = 'active' where id = pg_temp.fx('grace@A') returning joined_at)
select ok(count(*) = 1 and bool_and(joined_at is not null), 'owner approves a pending membership and joined_at is set') from u;

with u as (update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 1, 'owner suspends a member') from u;

select pg_temp.login(pg_temp.fx('carol'));
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'suspended member loses all permissions');
select is_empty($$ select 1 from public.communities where id = pg_temp.fx('A') $$, 'suspended member can no longer read the community');
select results_eq(
  $$ select status from public.memberships where id = pg_temp.fx('carol@A') $$,
  $$ values ('suspended') $$,
  'suspended member can still see her own membership status'
);

select pg_temp.login(pg_temp.fx('alice'));
with u as (update public.memberships set status = 'active' where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 1, 'owner reinstates a suspended member') from u;

select throws_ok(
  format($$ update public.memberships set status = 'pending' where id = %L $$, pg_temp.fx('carol@A')),
  '22023', null, 'invalid status transitions are rejected'
);

-- Moderator: may suspend but not approve ---------------------------------------
reset role;
insert into auth.users (id, email) values ('12121212-0000-4000-8000-000000000008', 'henry@example.test');
insert into fx values ('henry', '12121212-0000-4000-8000-000000000008');
select pg_temp.add_member('A', 'henry', null, 'pending');

select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.memberships set status = 'active' where id = %L $$, pg_temp.fx('henry@A')),
  '%insufficient privileges%', 'moderator cannot approve memberships (no members.approve)'
);
with u as (update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 1, 'moderator can suspend a member') from u;
with d as (delete from public.memberships where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 0, 'moderator cannot remove members (no members.remove)') from d;

select pg_temp.login(pg_temp.fx('alice'));
with u as (update public.memberships set status = 'rejected' where id = pg_temp.fx('henry@A') returning 1)
select is(count(*)::int, 1, 'owner rejects a pending membership') from u;

-- Removal ------------------------------------------------------------------------
with d as (delete from public.memberships where id = pg_temp.fx('carol@A') returning 1)
select is(count(*)::int, 1, 'owner removes a member') from d;
reset role;
select is_empty($$ select 1 from public.membership_roles where membership_id = pg_temp.fx('carol@A') $$, 'removing a membership removes its role assignments');

select pg_temp.login(pg_temp.fx('alice'));
with d as (delete from public.memberships where id = pg_temp.fx('alice@A') returning 1)
select is(count(*)::int, 0, 'members cannot delete their own membership (they leave instead)') from d;

-- Leaving ------------------------------------------------------------------------
select pg_temp.login(pg_temp.fx('dave'));
with u as (update public.memberships set status = 'left' where id = pg_temp.fx('dave@A') returning 1)
select is(count(*)::int, 1, 'a member can leave') from u;
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'a member who left loses access');

select pg_temp.login(pg_temp.fx('alice'));
select throws_like(
  format($$ update public.memberships set status = 'left' where id = %L $$, pg_temp.fx('alice@A')),
  '%last member able to manage roles%', 'the last role manager cannot leave'
);
select lives_ok(
  format($$ insert into public.membership_roles (membership_id, role_id) values (%L, %L) $$,
         pg_temp.fx('erin@A'), pg_temp.role_id('A', 'Owner')),
  'owner promotes an admin to owner'
);
with u as (update public.memberships set status = 'left' where id = pg_temp.fx('alice@A') returning 1)
select is(count(*)::int, 1, 'owner can leave once another owner exists') from u;

-- 11. Duplicate membership is prevented -------------------------------------------
reset role;
select throws_ok(
  format($$ insert into public.memberships (community_id, user_id) values (%L, %L) $$, pg_temp.fx('A'), pg_temp.fx('erin')),
  '23505', null, 'duplicate (community, user) membership is rejected'
);

-- Referential behaviour ----------------------------------------------------------
select throws_ok(
  format($$ delete from public.communities where id = %L $$, pg_temp.fx('B')),
  '23503', null, 'a community with memberships cannot be hard-deleted (RESTRICT)'
);
delete from auth.users where id = pg_temp.fx('frank');
select is_empty($$ select 1 from public.memberships where user_id = pg_temp.fx('frank') $$, 'deleting a user account removes their memberships');
select isnt_empty($$ select 1 from public.communities where id = pg_temp.fx('B') $$, 'deleting a member does not delete the community');
delete from auth.users where id = pg_temp.fx('bob');
select is(
  (select created_by from public.communities where id = pg_temp.fx('B')), null::uuid,
  'deleting the creator account sets communities.created_by to NULL'
);

select * from finish();
rollback;

-- has_community_permission() resolution for every default role and edge case.
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
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
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

-- 10. Permission checks resolve user -> membership -> role -> permission ------
create function pg_temp.my_keys(p_community text) returns setof text language sql as $$
  select key from public.permissions
  where public.has_community_permission(pg_temp.fx(p_community), key)
  order by key
$$;
create function pg_temp.template_keys(p_template text) returns setof text language sql as $$
  select p.key from public.role_template_permissions tp
  join public.role_templates t on t.id = tp.template_id
  join public.permissions p on p.id = tp.permission_id
  where t.key = p_template order by p.key
$$;
grant all on table fx to public;

select pg_temp.login(pg_temp.fx('alice'));
select results_eq($$ select pg_temp.my_keys('A') $$, $$ select pg_temp.template_keys('owner') $$, 'Owner holds exactly the Owner permissions');
select results_eq($$ select pg_temp.my_keys('B') $$, $$ select pg_temp.template_keys('member') $$, 'the same user holds only Member permissions in B');

select pg_temp.login(pg_temp.fx('erin'));
select results_eq($$ select pg_temp.my_keys('A') $$, $$ select pg_temp.template_keys('admin') $$, 'Admin holds exactly the Admin permissions');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'roles.manage'), 'Admin lacks roles.manage');

select pg_temp.login(pg_temp.fx('dave'));
select results_eq($$ select pg_temp.my_keys('A') $$, $$ select pg_temp.template_keys('moderator') $$, 'Moderator holds exactly the Moderator permissions');

select pg_temp.login(pg_temp.fx('carol'));
select results_eq($$ select pg_temp.my_keys('A') $$, $$ select pg_temp.template_keys('member') $$, 'Member holds exactly the Member permissions');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'members.approve'), 'Member cannot approve members');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'no.such_permission'), 'unknown permission keys are denied');
select ok(not public.has_community_permission(gen_random_uuid(), 'community.view'), 'unknown communities are denied');

select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select pg_temp.my_keys('A') $$, 'non-members hold no permissions');

select pg_temp.login(pg_temp.fx('grace'));
select is_empty($$ select pg_temp.my_keys('A') $$, 'pending members hold no permissions');

-- Identity comes only from the JWT -------------------------------------------
select set_config('request.jwt.claims', '', true);
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'no authenticated user means no permissions');

reset role;
set local role anon;
select throws_ok(
  format($$ select public.has_community_permission(%L, 'community.view') $$, pg_temp.fx('A')),
  '42501', null, 'anon cannot execute has_community_permission'
);
reset role;

-- Role permission changes take effect immediately -------------------------------
delete from public.role_permissions
where role_id = pg_temp.role_id('A', 'Member')
  and permission_id = (select id from public.permissions where key = 'posts.create');
select pg_temp.login(pg_temp.fx('carol'));
select ok(not public.has_community_permission(pg_temp.fx('A'), 'posts.create'), 'revoking a permission from a role revokes it from holders');

-- Community status gates all permissions ---------------------------------------
reset role;
update public.communities set status = 'suspended' where id = pg_temp.fx('A');
select pg_temp.login(pg_temp.fx('alice'));
select is_empty($$ select pg_temp.my_keys('A') $$, 'a suspended community grants no permissions, even to its owner');
select isnt_empty($$ select pg_temp.my_keys('B') $$, 'other communities are unaffected');

select * from finish();
rollback;

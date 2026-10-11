-- Stage 2: identity requires a live session and an active account (logout, revoked/expired sessions, suspension).
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

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

-- Helper: set arbitrary claims (as PostgREST would after verifying a JWT).
create function pg_temp.claims(p jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', p::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Valid session --------------------------------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select is(private.current_session_user_id(), pg_temp.fx('carol'), 'live session resolves to the user');
select is(private.current_active_user_id(), pg_temp.fx('carol'), 'active account resolves to the user');
select ok(public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'live session has community permissions');

-- Signed JWTs that do not correspond to a live session ------------------------
select pg_temp.claims(jsonb_build_object('sub', pg_temp.fx('carol'), 'role', 'authenticated'));
select is(private.current_session_user_id(), null, 'a token without session_id is not a session');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'a token without session_id has no permissions');
select is_empty($$ select 1 from public.profiles $$, 'a token without session_id cannot read profiles');
select throws_ok($$ select public.create_community('X', 'no-session') $$, '42501', 'authentication required', 'a token without session_id cannot create communities');

select pg_temp.claims(jsonb_build_object('sub', pg_temp.fx('carol'), 'role', 'authenticated', 'session_id', pg_temp.fx('alice')));
select is(private.current_session_user_id(), null, 'another user''s session_id is rejected');

select pg_temp.claims(jsonb_build_object('sub', pg_temp.fx('carol'), 'role', 'authenticated', 'session_id', 'not-a-uuid'));
select is(private.current_session_user_id(), null, 'a malformed session_id is rejected without error');

select pg_temp.claims(jsonb_build_object('sub', pg_temp.fx('carol'), 'role', 'authenticated', 'session_id', pg_temp.fx('carol'), 'is_anonymous', true));
select is(private.current_session_user_id(), null, 'anonymous sessions are rejected');

select pg_temp.claims(jsonb_build_object('sub', pg_temp.fx('carol'), 'role', 'anon', 'session_id', pg_temp.fx('carol')));
select is(private.current_session_user_id(), null, 'tokens whose role claim is not authenticated are rejected');

-- Session lifecycle -------------------------------------------------------------
reset role;
update auth.sessions set not_after = now() - interval '1 minute' where id = pg_temp.fx('carol');
select pg_temp.login(pg_temp.fx('carol'));
select is(private.current_session_user_id(), null, 'a session past not_after is rejected');

reset role;
update auth.sessions set not_after = now() + interval '1 hour' where id = pg_temp.fx('carol');
select pg_temp.login(pg_temp.fx('carol'));
select is(private.current_session_user_id(), pg_temp.fx('carol'), 'a session before not_after is accepted');

-- Logout: Supabase Auth deletes the session row; the still-valid JWT dies with it.
reset role;
delete from auth.sessions where id = pg_temp.fx('carol');
select pg_temp.login(pg_temp.fx('carol'));
select is(private.current_session_user_id(), null, 'after logout the old token resolves to nobody');
select is_empty($$ select 1 from public.communities $$, 'after logout the old token cannot read communities');
select is_empty($$ select 1 from public.profiles where id = pg_temp.fx('carol') $$, 'after logout the old token cannot read even its own profile');
with u as (update public.profiles set bio = 'still here?' where id = pg_temp.fx('carol') returning 1)
select is(count(*)::int, 0, 'after logout the old token cannot update its profile') from u;

-- Account status --------------------------------------------------------------
reset role;
update public.profiles set status = 'suspended' where id = pg_temp.fx('erin');
select pg_temp.login(pg_temp.fx('erin'));
select is(private.current_session_user_id(), pg_temp.fx('erin'), 'suspended user still has a live session');
select is(private.current_active_user_id(), null, 'suspended user is not an active user');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'suspended account loses all community permissions');
select is_empty($$ select 1 from public.communities $$, 'suspended account cannot read communities');
select is_empty($$ select 1 from public.memberships $$, 'suspended account cannot read memberships');
select results_eq(
  $$ select status from public.profiles where id = pg_temp.fx('erin') $$,
  $$ values ('suspended') $$,
  'suspended user can still read her own profile (to learn why access stopped)'
);
with u as (update public.profiles set bio = 'let me in' where id = pg_temp.fx('erin') returning 1)
select is(count(*)::int, 0, 'suspended user cannot update her profile') from u;
select throws_ok($$ select public.create_community('X', 'suspended-user') $$, '42501', 'authentication required', 'suspended user cannot create communities');

reset role;
update public.profiles set status = 'deactivated' where id = pg_temp.fx('dave');
select pg_temp.login(pg_temp.fx('dave'));
select is(private.current_active_user_id(), null, 'deactivated account is not an active user');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'members.suspend'), 'deactivated account loses all community permissions');

-- Unaffected users keep working --------------------------------------------------
select pg_temp.login(pg_temp.fx('alice'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'roles.manage'), 'other users are unaffected');

select * from finish();
rollback;

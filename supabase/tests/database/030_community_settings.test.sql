-- RN-15: per-community notification preferences (enforced at creation; urgent/emergency always delivered), community.update rules, leaving and the last role manager.
begin;
create extension if not exists pgtap with schema extensions;

select plan(38);

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

create function pg_temp.inbox(p_user text, p_type text) returns bigint language sql security definer as $$
  select count(*) from public.notifications where user_id = pg_temp.fx(p_user) and type = p_type
$$;
create function pg_temp.fan_out(p_community text, p_type text, p_key text, p_data jsonb default '{}') returns integer language sql security definer as $$
  select private.notify_community(pg_temp.fx(p_community), 'community.view', p_type, 'Title', null, p_data, p_key)
$$;
create function pg_temp.direct(p_user text, p_community text, p_type text, p_key text, p_data jsonb default '{}') returns uuid language sql security definer as $$
  select private.create_notification(pg_temp.fx(p_user), pg_temp.fx(p_community), p_type, 'Title', null, p_data, p_key)
$$;

-- =========================================================================
-- 1. Reading and setting preferences
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(format($$ select * from public.my_community_notification_settings(%L) $$, pg_temp.fx('A')),
  $$ values (true, true, true, true) $$, '1. everything is on by default');
select results_eq(format($$ select * from public.set_community_notification_settings(%L, p_announcements => false) $$, pg_temp.fx('A')),
  $$ values (false, true, true, true) $$, '1. one kind turned off; the rest unchanged');
select results_eq(format($$ select * from public.set_community_notification_settings(%L, p_comments => false, p_alerts => false) $$, pg_temp.fx('A')),
  $$ values (false, true, false, false) $$, '1. later changes keep earlier ones');
select is((select count(*) from public.community_notification_settings), 1::bigint, '1. a member reads their own preferences');
select throws_ok(format($$ select * from public.my_community_notification_settings(%L) $$, pg_temp.fx('B')),
  '42501', null, '1. not for a community you do not belong to');
select throws_ok(format($$ select * from public.set_community_notification_settings(%L, false) $$, pg_temp.fx('B')),
  '42501', null, '1. ...nor set');
select throws_ok(format($$ insert into public.community_notification_settings (user_id, community_id) values (%L, %L) $$,
  pg_temp.fx('dave'), pg_temp.fx('A')), '42501', null, '1. no direct writes (someone else''s preferences cannot be created)');
select pg_temp.login(pg_temp.fx('dave'));
select is((select count(*) from public.community_notification_settings), 0::bigint, '1. other members'' preferences are invisible');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(format($$ select * from public.my_community_notification_settings(%L) $$, pg_temp.fx('A')),
  '42501', null, '1. a pending member has no preferences yet');

-- =========================================================================
-- 2. Enforced where notifications are created
-- =========================================================================
reset role;
select is(pg_temp.fan_out('A', 'announcement', 'ann-1'), 3, '2. an announcement reaches the other active members (alice, erin, dave), not carol');
select is(pg_temp.inbox('carol', 'announcement'), 0::bigint, '2. carol turned announcements off');
select is(pg_temp.inbox('dave', 'announcement'), 1::bigint, '2. dave did not');
select is(pg_temp.direct('carol', 'A', 'comment', 'c-1'), null::uuid, '2. comments off: a reply notification is skipped');
select is(pg_temp.inbox('carol', 'comment'), 0::bigint, '2. ...and not stored');
select is(pg_temp.fan_out('A', 'alert', 'al-1', '{"severity": "warning"}'), 3, '2. a warning alert skips members who turned alerts off');
select is(pg_temp.inbox('carol', 'alert'), 0::bigint, '2. ...carol');
select is(pg_temp.fan_out('A', 'alert', 'al-2', '{"severity": "urgent"}'), 4, '2. an URGENT alert reaches everyone');
select is(pg_temp.fan_out('A', 'alert', 'al-3', '{"severity": "emergency"}'), 4, '2. an EMERGENCY alert reaches everyone');
select is(pg_temp.inbox('carol', 'alert'), 2::bigint, '2. carol got both, despite her preference');
select isnt(pg_temp.direct('carol', 'A', 'event_updated', 'ev-1'), null::uuid,
  '2. a change to an event she replied to is always delivered');
select isnt(pg_temp.direct('carol', 'A', 'membership', 'm-1'), null::uuid, '2. so is a membership change');
select is(pg_temp.fan_out('A', 'event_created', 'ev-new'), 4, '2. new events still on for carol (only what she turned off is skipped)');

-- Per community: alice mutes announcements in A only.
select pg_temp.login(pg_temp.fx('alice'));
select results_eq(format($$ select announcements from public.set_community_notification_settings(%L, false) $$, pg_temp.fx('A')),
  $$ values (false) $$, '2. alice turns announcements off in A');
reset role;
select is(pg_temp.fan_out('B', 'announcement', 'ann-b'), 3, '2. ...and still gets them from B (bob, frank, alice)');
select is(pg_temp.fan_out('A', 'announcement', 'ann-2'), 2, '2. ...but not from A (only erin and dave)');

-- =========================================================================
-- 3. Community details: community.update only; slug and status never
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ update public.communities set name = 'Admin renamed', description = 'New', timezone = 'Europe/London' where id = %L $$, pg_temp.fx('A')),
  '3. an Admin edits the name, description and time zone');
select throws_ok(format($$ update public.communities set timezone = 'Mars/Olympus' where id = %L $$, pg_temp.fx('A')),
  null, null, '3. an unknown time zone is refused');
select throws_ok(format($$ update public.communities set slug = 'stolen' where id = %L $$, pg_temp.fx('A')),
  '42501', null, '3. the slug is never client-editable');
select throws_ok(format($$ update public.communities set status = 'archived' where id = %L $$, pg_temp.fx('A')),
  '42501', null, '3. nor is the status');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty(format($$ update public.communities set name = 'Moderator renamed' where id = %L returning 1 $$, pg_temp.fx('A')),
  '3. a Moderator cannot edit the community');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(format($$ update public.communities set name = 'Member renamed' where id = %L returning 1 $$, pg_temp.fx('A')),
  '3. a Member cannot edit the community');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty(format($$ update public.communities set name = 'Outsider renamed' where id = %L returning 1 $$, pg_temp.fx('A')),
  '3. an outsider cannot edit it');
reset role;
select is((select name from public.communities where id = pg_temp.fx('A')), 'Admin renamed', '3. only the Admin''s change stuck');

-- =========================================================================
-- 4. Leaving: anyone, except the last member able to manage roles
-- =========================================================================
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok(format($$ update public.memberships set status = 'left' where community_id = %L and user_id = %L $$, pg_temp.fx('A'), pg_temp.fx('alice')),
  '42501', null, '4. the Owner (the only one who can manage roles) cannot leave');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ update public.memberships set status = 'left' where community_id = %L and user_id = %L $$, pg_temp.fx('A'), pg_temp.fx('erin')),
  '4. an Admin can leave');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ update public.memberships set status = 'left' where community_id = %L and user_id = %L $$, pg_temp.fx('A'), pg_temp.fx('carol')),
  '4. a Member can leave');
select throws_ok(format($$ select * from public.my_community_notification_settings(%L) $$, pg_temp.fx('A')),
  '42501', null, '4. after leaving, the community''s settings are no longer reachable');
reset role;
select is(pg_temp.fan_out('A', 'announcement', 'ann-3'), 1, '4. and nothing more is sent to those who left (only dave; alice muted)');

select * from finish();
rollback;

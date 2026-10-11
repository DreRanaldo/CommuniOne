-- Stage 7: alerts: authorization, emergency severity, lifecycle, expiry, outbox events, isolation, escalation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(69);

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

-- Custom "Alerter" role in A: alerts.view + alerts.create, NOT alerts.manage.
-- Given to dave (Moderator) to test the non-manager author path.
select pg_temp.login(pg_temp.fx('alice'));
insert into public.roles (community_id, name) values (pg_temp.fx('A'), 'Alerter');
insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('A', 'Alerter'), id from public.permissions where key in ('alerts.view', 'alerts.create');
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('dave@A'), pg_temp.role_id('A', 'Alerter'));

select pg_temp.login(pg_temp.fx('bob'));
insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('B'), 'B notice', 'Only for B', 'warning', 'published');

-- =========================================================================
-- 1. Authorized alert creation
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.alerts (community_id, title, body, severity) values (pg_temp.fx('A'), 'Storm watch', 'Heavy rain expected.', 'warning') returning id)
insert into fx select 'al_draft', id from i;
select results_eq(
  $$ select status, created_by, severity_rank, is_emergency, published_at from public.alerts where id = pg_temp.fx('al_draft') $$,
  $$ values ('draft', pg_temp.fx('erin'), 2::smallint, false, null::timestamptz) $$,
  '1. an authorized user saves a draft alert (creator from the session)'
);
with i as (insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'Gate broken', 'North gate is stuck open.', 'urgent', 'published') returning id)
insert into fx select 'al_urgent', id from i;
select results_eq(
  $$ select status, published_by, published_at is not null from public.alerts where id = pg_temp.fx('al_urgent') $$,
  $$ values ('published', pg_temp.fx('erin'), true) $$,
  '1. an authorized user creates and publishes an alert in one step'
);
select results_eq(
  $$ select event_type, severity, actor_user_id from public.alert_events where alert_id = pg_temp.fx('al_urgent') $$,
  $$ values ('published', 'urgent', pg_temp.fx('erin')) $$,
  'publishing records a notification outbox event'
);

-- =========================================================================
-- 2. Unauthorized alert creation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body) values (%L, 'Hi', 'Member alert') $$, pg_temp.fx('A')),
  '42501', null, '2. a normal member cannot create an alert'
);
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body) values (%L, 'Hi', 'Pending alert') $$, pg_temp.fx('A')),
  '42501', null, '2. a pending member cannot create an alert'
);
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body) values (%L, 'Hi', 'From B') $$, pg_temp.fx('A')),
  '42501', null, '2. a member of another community cannot create an alert'
);

-- =========================================================================
-- 3. Emergency alert authorization (severity is never trusted)
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity, status) values (%L, 'FIRE', 'Evacuate', 'emergency', 'published') $$, pg_temp.fx('A')),
  '42501', null, '3. a normal member cannot create an emergency alert'
);
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ insert into public.alerts (community_id, title, body, severity) values (%L, 'FIRE', 'Evacuate', 'emergency') $$, pg_temp.fx('A')),
  '%emergency alerts require alerts.manage%', '3. alerts.create alone cannot create an emergency alert, even as a draft'
);
with i as (insert into public.alerts (community_id, title, body, severity) values (pg_temp.fx('A'), 'Pool chemicals', 'Pool closed today.', 'info') returning id)
insert into fx select 'al_dave', id from i;
update public.alerts set severity = 'urgent' where id = pg_temp.fx('al_dave');
select is((select severity from public.alerts where id = pg_temp.fx('al_dave')), 'urgent', '3. an author may change severity of her own draft below emergency');
select throws_like(
  format($$ update public.alerts set severity = 'emergency' where id = %L $$, pg_temp.fx('al_dave')),
  '%requires alerts.manage%', '3. an author without alerts.manage cannot escalate to emergency'
);
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity) values (%L, 't', 'b', 'critical') $$, pg_temp.fx('A')),
  '23514', null, '3. unknown severities are rejected'
);
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity_rank) values (%L, 't', 'b', 4) $$, pg_temp.fx('A')),
  null, null, '3. severity_rank is derived and cannot be supplied'
);
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, is_emergency) values (%L, 't', 'b', true) $$, pg_temp.fx('A')),
  null, null, '3. is_emergency is derived and cannot be supplied'
);

select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'Gas leak', 'Evacuate building C now.', 'emergency', 'published') returning id)
insert into fx select 'al_emergency', id from i;
select results_eq(
  $$ select is_emergency, severity_rank from public.alerts where id = pg_temp.fx('al_emergency') $$,
  $$ values (true, 4::smallint) $$,
  '3. alerts.manage can publish an emergency alert; it is flagged as emergency'
);

-- =========================================================================
-- 4. Publishing authorization
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.alerts set status = 'published' where id = pg_temp.fx('al_draft') returning 1)
select is(count(*)::int, 0, '4. a normal member cannot publish an alert') from u;
select pg_temp.login(pg_temp.fx('dave'));
with u as (update public.alerts set status = 'published' where id = pg_temp.fx('al_draft') returning 1)
select is(count(*)::int, 0, '4. alerts.create cannot publish someone else''s alert') from u;
select throws_like(
  format($$ update public.alerts set status = 'published', expires_at = now() - interval '1 hour' where id = %L $$, pg_temp.fx('al_dave')),
  '%expires_at must be in the future%', '4. an alert cannot be published already expired'
);
update public.alerts set status = 'published', expires_at = now() + interval '2 hours' where id = pg_temp.fx('al_dave');
select results_eq(
  $$ select status, published_by from public.alerts where id = pg_temp.fx('al_dave') $$,
  $$ values ('published', pg_temp.fx('dave')) $$,
  '4. an author with alerts.create publishes her own non-emergency alert'
);
select pg_temp.login(pg_temp.fx('erin'));
update public.alerts set status = 'published' where id = pg_temp.fx('al_draft');
select is((select status from public.alerts where id = pg_temp.fx('al_draft')), 'published', '4. the creator publishes her draft');

-- =========================================================================
-- 5. Editing authorization
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.alerts set severity = 'info' where id = %L $$, pg_temp.fx('al_dave')),
  '%requires alerts.manage%', '5. changing severity of a published alert requires alerts.manage'
);
update public.alerts set body = 'Pool closed until 6pm.' where id = pg_temp.fx('al_dave');
select isnt((select edited_at from public.alerts where id = pg_temp.fx('al_dave')), null, '5. an author corrects her published alert (edited_at stamped)');
with u as (update public.alerts set body = 'Not mine' where id = pg_temp.fx('al_emergency') returning 1)
select is(count(*)::int, 0, '5. alerts.create cannot edit another user''s alert') from u;
with u as (update public.alerts set severity = 'info' where id = pg_temp.fx('al_emergency') returning 1)
select is(count(*)::int, 0, '5. ...or downgrade someone else''s emergency') from u;

select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.alerts set title = 'Hacked' where id = pg_temp.fx('al_urgent') returning 1)
select is(count(*)::int, 0, '5. a normal member cannot edit an alert') from u;

select pg_temp.login(pg_temp.fx('alice'));
update public.alerts set severity = 'emergency', body = 'Gate stuck open: intruder reported.' where id = pg_temp.fx('al_urgent');
select results_eq(
  $$ select severity, updated_by_user_id from public.alerts where id = pg_temp.fx('al_urgent') $$,
  $$ values ('emergency', pg_temp.fx('alice')) $$,
  '5. a manager escalates another user''s published alert'
);
select results_eq(
  $$ select event_type, severity, actor_user_id from public.alert_events where alert_id = pg_temp.fx('al_urgent') order by occurred_at, event_type $$,
  $$ values ('published', 'urgent', pg_temp.fx('erin')), ('updated', 'emergency', pg_temp.fx('alice')) $$,
  '5. edits to a published alert record an updated event with the new severity'
);

-- =========================================================================
-- 6. Cancellation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.alerts set status = 'cancelled' where id = pg_temp.fx('al_dave') returning 1)
select is(count(*)::int, 0, '6. a normal member cannot cancel an alert') from u;
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.alerts set cancellation_reason = 'just because' where id = %L $$, pg_temp.fx('al_dave')),
  '%only be given when cancelling%', '6. a cancellation reason is only accepted when cancelling'
);
update public.alerts set status = 'cancelled', cancellation_reason = 'Pool reopened early' where id = pg_temp.fx('al_dave');
select results_eq(
  $$ select status, cancelled_by, cancelled_at is not null, cancellation_reason from public.alerts where id = pg_temp.fx('al_dave') $$,
  $$ values ('cancelled', pg_temp.fx('dave'), true, 'Pool reopened early') $$,
  '6. the author cancels her alert with a reason'
);
reset role;
select is(
  (select count(*)::int from public.alert_events where alert_id = pg_temp.fx('al_dave') and event_type = 'cancelled'), 1,
  '6. cancellation records an outbox event'
);
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.alerts set body = 'edit cancelled' where id = %L $$, pg_temp.fx('al_dave')),
  '%only draft or published%', '6. a cancelled alert cannot be edited'
);
select throws_like(
  format($$ update public.alerts set status = 'published' where id = %L $$, pg_temp.fx('al_dave')),
  '%invalid alert transition%', '6. a cancelled alert cannot be republished'
);
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select status, is_active, cancellation_reason from public.list_alert_history(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('al_dave')),
  $$ values ('cancelled', false, 'Pool reopened early') $$,
  '6. members see the cancellation in the history'
);
select is_empty(
  format($$ select 1 from public.list_active_alerts(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('al_dave')),
  '6. a cancelled alert is not active'
);
select pg_temp.login(pg_temp.fx('dave'));
with i as (insert into public.alerts (community_id, title, body) values (pg_temp.fx('A'), 'Scratch', 'discard me') returning id)
insert into fx select 'al_discard', id from i;
update public.alerts set status = 'cancelled' where id = pg_temp.fx('al_discard');
select results_eq(
  $$ select status, published_at, (select count(*)::int from public.alert_events e where e.alert_id = a.id) from public.alerts a where id = pg_temp.fx('al_discard') $$,
  $$ values ('cancelled', null::timestamptz, 0) $$,
  '6. discarding a draft cancels it without any notification event'
);
update public.alerts set status = 'archived' where id = pg_temp.fx('al_dave');
select throws_like(
  format($$ update public.alerts set status = 'cancelled' where id = %L $$, pg_temp.fx('al_dave')),
  '%archived alerts cannot be modified%', 'archived is terminal'
);

-- =========================================================================
-- 7. Expiration
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
update public.alerts set status = 'expired' where id = pg_temp.fx('al_draft');
select results_eq(
  $$ select status, expired_at is not null from public.alerts where id = pg_temp.fx('al_draft') $$,
  $$ values ('expired', true) $$,
  '7. an authorized user ends an alert early (manual expire)'
);
select throws_like(
  format($$ update public.alerts set status = 'published' where id = %L $$, pg_temp.fx('al_draft')),
  '%invalid alert transition%', '7. an expired alert cannot be republished'
);
select throws_like(
  format($$ update public.alerts set expires_at = now() - interval '1 minute' where id = %L $$, pg_temp.fx('al_emergency')),
  '%use status = expired%', '7. expires_at cannot be moved into the past on a published alert'
);

-- Time-based expiry: an alert past its expires_at is no longer active even
-- before the sweep runs.
reset role;
update public.alerts set published_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
where id = pg_temp.fx('al_emergency');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(
  format($$ select 1 from public.list_active_alerts(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('al_emergency')),
  '7. an alert past expires_at is not active, before any sweep'
);
select results_eq(
  format($$ select status, is_active from public.list_alert_history(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('al_emergency')),
  $$ values ('published', false) $$,
  '7. the history shows it as no longer active'
);
select throws_ok($$ select public.expire_due_alerts() $$, '42501', null, '7. clients cannot run the expiry sweep');
select ok(
  has_function_privilege('service_role', 'private.current_active_user_id()', 'execute')
  and has_function_privilege('service_role', 'public.expire_due_alerts()', 'execute'),
  '7. the service role can run the sweep and the identity helpers its triggers use'
);
reset role;
set local role service_role;
select is(public.expire_due_alerts(), 1, '7. the expiry sweep (service role) expires due alerts');
reset role;
select results_eq(
  $$ select a.status, e.event_type, e.actor_user_id from public.alerts a join public.alert_events e on e.alert_id = a.id
     where a.id = pg_temp.fx('al_emergency') and e.event_type = 'expired' $$,
  $$ values ('expired', 'expired', null::uuid) $$,
  '7. the sweep records an expired event (system actor)'
);

-- =========================================================================
-- 8. Community isolation
-- =========================================================================
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.alerts where id = pg_temp.fx('al_urgent') $$, '8. another community''s alert cannot be read by id');
select is_empty($$ select 1 from public.alerts where community_id = pg_temp.fx('A') $$, '8. ...or by community id');
select is_empty(format($$ select * from public.list_active_alerts(%L) $$, pg_temp.fx('A')), '8. ...or through list_active_alerts');
select is_empty(format($$ select * from public.list_alert_history(%L) $$, pg_temp.fx('A')), '8. ...or through list_alert_history');
select results_eq(
  $$ select title from public.list_my_active_alerts() $$,
  $$ values ('B notice') $$,
  '8. list_my_active_alerts only covers the caller''s communities'
);
select pg_temp.login(pg_temp.fx('bob'));
with u as (update public.alerts set status = 'cancelled' where id = pg_temp.fx('al_urgent') returning 1)
select is(count(*)::int, 0, '8. the Owner of B cannot cancel A''s alert') from u;
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity) values (%L, 'x', 'B owner in A', 'emergency') $$, pg_temp.fx('A')),
  '42501', null, '8. the Owner of B cannot raise an emergency in A'
);
select pg_temp.login(pg_temp.fx('alice'));
select results_eq(
  $$ select title, is_emergency from public.list_my_active_alerts() $$,
  $$ values ('Gate broken', true), ('B notice', false) $$,
  '8. a multi-community user sees active alerts from each community, emergencies first'
);

-- =========================================================================
-- 9. RLS
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.alerts (community_id, title, body) values (pg_temp.fx('A'), 'Secret draft', 'Not yet') returning id)
insert into fx select 'al_secret', id from i;
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.alerts where id = pg_temp.fx('al_secret') $$, '9. drafts are invisible to members');
select is_empty($$ select 1 from public.alert_events $$, '9. members cannot read the alert event log');
select throws_ok(
  format($$ insert into public.alert_events (alert_id, community_id, event_type, severity) values (%L, %L, 'published', 'emergency') $$,
         pg_temp.fx('al_urgent'), pg_temp.fx('A')),
  '42501', null, '9. clients cannot write notification events'
);
select throws_ok(
  format($$ delete from public.alerts where id = %L $$, pg_temp.fx('al_urgent')),
  '42501', null, '9. alerts cannot be deleted by clients'
);
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from public.alerts where id = pg_temp.fx('al_secret') $$, '9. drafts are invisible to non-manager authors of other alerts');
select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty($$ select 1 from public.alerts where id = pg_temp.fx('al_secret') $$, '9. managers see drafts');
select isnt_empty($$ select 1 from public.alert_events where alert_id = pg_temp.fx('al_urgent') $$, '9. managers can audit alert events');

-- =========================================================================
-- 10. Attempted privilege escalation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ update public.alerts set published_by = %L where id = %L $$, pg_temp.fx('alice'), pg_temp.fx('al_urgent')),
  '42501', null, '10. nobody can forge who published an alert'
);
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, created_by) values (%L, 'x', 'y', %L) $$, pg_temp.fx('A'), pg_temp.fx('alice')),
  '42501', null, '10. an author cannot impersonate an administrator as creator'
);
select throws_ok(
  format($$ update public.alerts set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('al_secret')),
  '42501', null, '10. an alert cannot be moved to another community'
);
select throws_like(
  format($$ insert into public.role_permissions (role_id, permission_id) select %L, id from public.permissions where key = 'alerts.manage' $$,
         pg_temp.role_id('A', 'Alerter')),
  '%row-level security%', '10. an alert author cannot grant herself alerts.manage'
);
select ok(not public.has_community_permission(pg_temp.fx('A'), 'alerts.manage'), '10. ...and still lacks alerts.manage');

reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('erin@A');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(
  format($$ insert into public.alerts (community_id, title, body, severity) values (%L, 'x', 'suspended admin', 'emergency') $$, pg_temp.fx('A')),
  '42501', null, '10. a suspended administrator cannot raise alerts'
);
with u as (update public.alerts set status = 'published' where id = pg_temp.fx('al_secret') returning 1)
select is(count(*)::int, 0, '10. a suspended administrator cannot publish her drafts') from u;

reset role;
set local role anon;
select throws_ok($$ select * from public.alerts $$, '42501', null, 'anon cannot read alerts');
select throws_ok($$ select * from public.list_my_active_alerts() $$, '42501', null, 'anon cannot list alerts');

select * from finish();
rollback;

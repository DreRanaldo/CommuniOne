-- Stage 8: events and RSVPs: lifecycle, authorization, capacity, waitlist, isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(72);

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

-- Extra Community A members for capacity tests.
insert into auth.users (id, email)
select ('a0a0a0a0-0000-4000-8000-00000000000' || i)::uuid, 'm' || i || '@example.test' from generate_series(1, 4) as i;
insert into auth.sessions (id, user_id)
select ('a0a0a0a0-0000-4000-8000-00000000000' || i)::uuid, ('a0a0a0a0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 4) as i;
insert into fx select 'm' || i, ('a0a0a0a0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 4) as i;
select pg_temp.add_member('A', 'm' || i, 'Member') from generate_series(1, 4) as i;

-- Test helpers (created as the database owner, before any login).
create function pg_temp.new_event(p_title text, p_status text default 'published', p_capacity integer default null)
returns uuid language sql as $$
  insert into public.events (community_id, title, starts_at, ends_at, capacity, status)
  values (pg_temp.fx('A'), p_title, now() + interval '7 days', now() + interval '7 days 2 hours', p_capacity, p_status)
  returning id
$$;
create function pg_temp.rsvp(p_user text, p_event text, p_status text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.login(pg_temp.fx(p_user));
  select r.status into v from public.rsvp_to_event(pg_temp.fx(p_event), p_status) r;
  return v;
end;
$$;
create function pg_temp.rsvp_status(p_user text, p_event text) returns text language sql security definer as $$
  select status from public.event_rsvps where user_id = pg_temp.fx(p_user) and event_id = pg_temp.fx(p_event)
$$;

-- Custom "Organizer" role (events.view + events.create, no events.manage) for dave.
select pg_temp.login(pg_temp.fx('alice'));
insert into public.roles (community_id, name) values (pg_temp.fx('A'), 'Organizer');
insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('A', 'Organizer'), id from public.permissions where key in ('events.view', 'events.create');
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('dave@A'), pg_temp.role_id('A', 'Organizer'));

-- =========================================================================
-- 1. Authorized event creation / 2. Unauthorized creation
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
insert into fx select 'ev_draft', pg_temp.new_event('Spring clean-up', 'draft');
select results_eq(
  $$ select status, created_by, published_at from public.events where id = pg_temp.fx('ev_draft') $$,
  $$ values ('draft', pg_temp.fx('erin'), null::timestamptz) $$,
  '1. an authorized user creates a draft event (creator from the session)'
);
select throws_ok(
  format($$ insert into public.events (community_id, title, starts_at, ends_at) values (%L, 'Backwards', now() + interval '2 days', now() + interval '1 day') $$, pg_temp.fx('A')),
  '23514', null, '1. ends_at cannot be before starts_at'
);
select throws_ok(
  format($$ insert into public.events (community_id, title, starts_at, ends_at, timezone) values (%L, 'x', now(), now(), 'Mars/Base') $$, pg_temp.fx('A')),
  '22023', null, '1. timezone must be a real IANA zone'
);
select throws_ok(
  format($$ insert into public.events (community_id, title, starts_at, ends_at, capacity) values (%L, 'x', now(), now(), 0) $$, pg_temp.fx('A')),
  '23514', null, '1. capacity must be positive'
);
select throws_ok(
  format($$ insert into public.events (community_id, title, starts_at, ends_at, created_by) values (%L, 'x', now(), now(), %L) $$, pg_temp.fx('A'), pg_temp.fx('alice')),
  '42501', null, '1. created_by cannot be supplied by clients'
);

select pg_temp.login(pg_temp.fx('carol'));
select throws_like(
  format($$ insert into public.events (community_id, title, starts_at, ends_at) values (%L, 'Member party', now() + interval '1 day', now() + interval '2 days') $$, pg_temp.fx('A')),
  '%row-level security%', '2. a normal member cannot create an event'
);
select pg_temp.login(pg_temp.fx('grace'));
select throws_like(
  format($$ insert into public.events (community_id, title, starts_at, ends_at) values (%L, 'x', now() + interval '1 day', now() + interval '2 days') $$, pg_temp.fx('A')),
  '%row-level security%', '2. a pending member cannot create an event'
);
select pg_temp.login(pg_temp.fx('alice'));
select throws_like(
  format($$ insert into public.events (community_id, title, starts_at, ends_at) values (%L, 'x', now() + interval '1 day', now() + interval '2 days') $$, pg_temp.fx('B')),
  '%row-level security%', '2. Owner of A cannot create events in B (changing community_id)'
);

-- =========================================================================
-- 3. Editing / 4. Publishing
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.events where id = pg_temp.fx('ev_draft') $$, '4. a draft event is invisible to members');

select pg_temp.login(pg_temp.fx('dave'));
insert into fx select 'ev_dave', pg_temp.new_event('Board games night', 'draft');
update public.events set location_text = 'Clubhouse' where id = pg_temp.fx('ev_dave');
select is((select location_text from public.events where id = pg_temp.fx('ev_dave')), 'Clubhouse', '3. an organizer (events.create) edits her own event');
with u as (update public.events set title = 'Mine now' where id = pg_temp.fx('ev_draft') returning 1)
select is(count(*)::int, 0, '3. events.create alone cannot edit another user''s event') from u;
with u as (update public.events set status = 'published' where id = pg_temp.fx('ev_draft') returning 1)
select is(count(*)::int, 0, '4. events.create alone cannot publish another user''s event') from u;

select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.events set title = 'Hacked' where id = pg_temp.fx('ev_dave') returning 1)
select is(count(*)::int, 0, '3. a normal member cannot edit an event') from u;

select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.events set status = 'published', starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' where id = %L $$, pg_temp.fx('ev_draft')),
  '%already ended cannot be published%', '4. an event that already ended cannot be published'
);
update public.events set status = 'published' where id = pg_temp.fx('ev_draft');
select isnt((select published_at from public.events where id = pg_temp.fx('ev_draft')), null, '4. an authorized user publishes an event');
insert into fx values ('ev_cleanup', pg_temp.fx('ev_draft'));
select pg_temp.login(pg_temp.fx('carol'));
select isnt_empty($$ select 1 from public.events where id = pg_temp.fx('ev_cleanup') $$, '4. members see published events');

select pg_temp.login(pg_temp.fx('alice'));
update public.events set description = 'Bring gloves' where id = pg_temp.fx('ev_cleanup');
select results_eq(
  $$ select description, edited_at is not null, updated_by_user_id from public.events where id = pg_temp.fx('ev_cleanup') $$,
  $$ values ('Bring gloves', true, pg_temp.fx('alice')) $$,
  '3. a manager edits another user''s published event (edited_at stamped)'
);
-- Attackers who CAN see the published event must still be refused (so the
-- update policy, not just read visibility, is what stops them).
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.events set title = 'Hacked', capacity = 100000 where id = pg_temp.fx('ev_cleanup') returning 1)
select is(count(*)::int, 0, '3. a member who can see a published event still cannot edit it') from u;
with u as (update public.events set status = 'cancelled' where id = pg_temp.fx('ev_cleanup') returning 1)
select is(count(*)::int, 0, '5. a member who can see a published event cannot cancel it') from u;
select pg_temp.login(pg_temp.fx('dave'));
with u as (update public.events set location_text = 'Elsewhere' where id = pg_temp.fx('ev_cleanup') returning 1)
select is(count(*)::int, 0, '3. events.create alone cannot edit another user''s published event') from u;
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok(
  format($$ update public.events set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('ev_cleanup')),
  '42501', null, '13. an event cannot be moved to another community'
);

-- =========================================================================
-- 6/7. RSVP and change RSVP; 9. duplicate
-- =========================================================================
select is(pg_temp.rsvp('carol', 'ev_cleanup', 'going'), 'going', '6. a member RSVPs going');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select going_count, my_status from public.get_event_attendance(pg_temp.fx('ev_cleanup')) $$,
  $$ values (1, 'going') $$,
  '6. attendance counts reflect the RSVP'
);
select is(pg_temp.rsvp('carol', 'ev_cleanup', 'maybe'), 'maybe', '7. a member changes her RSVP');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select going_count, maybe_count from public.get_event_attendance(pg_temp.fx('ev_cleanup')) $$,
  $$ values (0, 1) $$,
  '7. counts follow the change'
);
select throws_ok(
  format($$ insert into public.event_rsvps (event_id, status) values (%L, 'going') $$, pg_temp.fx('ev_cleanup')),
  '23505', null, '9. a second RSVP by the same user is rejected'
);
select throws_ok(
  format($$ select * from public.rsvp_to_event(%L, 'waitlisted') $$, pg_temp.fx('ev_cleanup')),
  '22023', null, 'members cannot choose waitlisted'
);
select throws_ok(
  format($$ insert into public.event_rsvps (event_id, status, user_id) values (%L, 'going', %L) $$, pg_temp.fx('ev_cleanup'), pg_temp.fx('m1')),
  '42501', null, 'a member cannot RSVP on behalf of someone else'
);

-- =========================================================================
-- 10. Capacity / 12. Waitlist
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
insert into fx select 'ev_small', pg_temp.new_event('Cooking class', 'published', 2);
select is(pg_temp.rsvp('carol', 'ev_small', 'going'), 'going', '10. first RSVP gets a place');
select is(pg_temp.rsvp('m1', 'ev_small', 'going'), 'going', '10. second RSVP gets the last place');
select is(pg_temp.rsvp('m2', 'ev_small', 'going'), 'waitlisted', '10/12. the third is waitlisted, not overbooked');
select is(pg_temp.rsvp('m3', 'ev_small', 'going'), 'waitlisted', '12. the fourth is waitlisted too');
select pg_temp.login(pg_temp.fx('m4'));
insert into public.event_rsvps (event_id, status) values (pg_temp.fx('ev_small'), 'going');
select is(pg_temp.rsvp_status('m4', 'ev_small'), 'waitlisted', '10. a direct insert of going cannot bypass capacity');
select throws_ok(
  format($$ update public.event_rsvps set waitlisted_at = now() - interval '1 year' where event_id = %L $$, pg_temp.fx('ev_small')),
  '42501', null, '12. a member cannot jump the queue by writing waitlisted_at'
);
update public.event_rsvps set status = 'going' where event_id = pg_temp.fx('ev_small');
select is(pg_temp.rsvp_status('m4', 'ev_small'), 'waitlisted', '10. updating a waitlisted RSVP to going cannot bypass capacity');
select pg_temp.login(pg_temp.fx('m3'));
select results_eq(
  $$ select capacity, going_count, waitlisted_count, spots_left, my_status, my_waitlist_position from public.get_event_attendance(pg_temp.fx('ev_small')) $$,
  $$ values (2, 2, 3, 0, 'waitlisted', 2) $$,
  '12. attendance shows capacity, counts and the caller''s queue position'
);

select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.events set capacity = 1 where id = %L $$, pg_temp.fx('ev_small')),
  '%cannot be lower than the number of people going%', '10. capacity cannot be lowered below the number going'
);

-- Cancelling a place promotes the waitlist in FIFO order.
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.cancel_rsvp(pg_temp.fx('ev_small')), 'cancel_rsvp removes the caller''s RSVP');
select results_eq(
  $$ select pg_temp.rsvp_status('m2', 'ev_small'), pg_temp.rsvp_status('m3', 'ev_small'), pg_temp.rsvp_status('m4', 'ev_small') $$,
  $$ values ('going', 'waitlisted', 'waitlisted') $$,
  '12. cancelling an RSVP promotes the first person on the waitlist'
);
select is(pg_temp.rsvp('m1', 'ev_small', 'not_going'), 'not_going', '12. changing from going to not_going frees a place');
select results_eq(
  $$ select pg_temp.rsvp_status('m3', 'ev_small'), pg_temp.rsvp_status('m4', 'ev_small') $$,
  $$ values ('going', 'waitlisted') $$,
  '12. ...which goes to the next person in line'
);
select is(pg_temp.rsvp('m1', 'ev_small', 'going'), 'waitlisted', '12. re-joining puts you at the back of the line');
select pg_temp.login(pg_temp.fx('erin'));
update public.events set capacity = 3 where id = pg_temp.fx('ev_small');
select results_eq(
  $$ select pg_temp.rsvp_status('m4', 'ev_small'), pg_temp.rsvp_status('m1', 'ev_small') $$,
  $$ values ('going', 'waitlisted') $$,
  '12. raising capacity promotes from the waitlist in order'
);
update public.events set capacity = null where id = pg_temp.fx('ev_small');
select is(pg_temp.rsvp_status('m1', 'ev_small'), 'going', '12. removing the capacity limit promotes everyone');
select pg_temp.login(pg_temp.fx('erin'));
select is((select count(*)::int from public.event_rsvps where event_id = pg_temp.fx('ev_small') and status = 'waitlisted'), 0, '12. nobody is left on the waitlist');

-- =========================================================================
-- RSVP privacy and other users' RSVPs
-- =========================================================================
select pg_temp.rsvp('m1', 'ev_cleanup', 'maybe');
select pg_temp.rsvp('m2', 'ev_cleanup', 'going');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select user_id from public.event_rsvps where event_id = %L order by user_id $$, pg_temp.fx('ev_cleanup')),
  format($$ values (%L::uuid), (%L::uuid) $$, pg_temp.fx('m2'), pg_temp.fx('carol')),
  'members see the attendee list (going) and their own RSVP, not other people''s maybe'
);
with u as (update public.event_rsvps set status = 'not_going' where user_id = pg_temp.fx('m2') and event_id = pg_temp.fx('ev_cleanup') returning 1)
select is(count(*)::int, 0, 'a member cannot modify another user''s RSVP') from u;
with d as (delete from public.event_rsvps where user_id = pg_temp.fx('m2') returning 1)
select is(count(*)::int, 0, 'a member cannot cancel another user''s RSVP') from d;
select pg_temp.login(pg_temp.fx('erin'));
select is((select count(*)::int from public.event_rsvps where event_id = pg_temp.fx('ev_cleanup')), 3, 'event managers see every RSVP');

-- =========================================================================
-- 5. Cancellation and completion
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
update public.events set status = 'cancelled', cancellation_reason = 'Rain' where id = pg_temp.fx('ev_cleanup');
select results_eq(
  $$ select status, cancelled_by, cancellation_reason from public.events where id = pg_temp.fx('ev_cleanup') $$,
  $$ values ('cancelled', pg_temp.fx('erin'), 'Rain') $$,
  '5. an authorized user cancels an event with a reason'
);
select pg_temp.login(pg_temp.fx('m3'));
select throws_like(
  format($$ select * from public.rsvp_to_event(%L, 'going') $$, pg_temp.fx('ev_cleanup')),
  '%row-level security%', '5. nobody can RSVP to a cancelled event'
);
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.events set status = 'published' where id = %L $$, pg_temp.fx('ev_cleanup')),
  '%cancelled events cannot be modified%', '5. a cancelled event is final'
);
select pg_temp.login(pg_temp.fx('carol'));
select isnt_empty($$ select 1 from public.events where id = pg_temp.fx('ev_cleanup') and status = 'cancelled' $$, '5. members still see the cancelled event');

select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.events set status = 'completed' where id = %L $$, pg_temp.fx('ev_small')),
  '%cannot be completed before it starts%', 'an event cannot be completed before it starts'
);
reset role;
update public.events set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = pg_temp.fx('ev_small');
select pg_temp.login(pg_temp.fx('erin'));
update public.events set status = 'completed' where id = pg_temp.fx('ev_small');
select is((select status from public.events where id = pg_temp.fx('ev_small')), 'completed', 'an event is completed after it starts');
select pg_temp.login(pg_temp.fx('m1'));
with d as (delete from public.event_rsvps where event_id = pg_temp.fx('ev_small') returning 1)
select is(count(*)::int, 0, 'RSVPs are frozen once an event has started') from d;

-- =========================================================================
-- 8 / 13. Cross-community
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
insert into fx select 'ev_open', pg_temp.new_event('Open house', 'published');
select pg_temp.login(pg_temp.fx('frank'));
select throws_like(
  format($$ select * from public.rsvp_to_event(%L, 'going') $$, pg_temp.fx('ev_open')),
  '%row-level security%', '8. a member cannot RSVP to another community''s event'
);
select is_empty($$ select 1 from public.events where id = pg_temp.fx('ev_open') $$, '13. another community''s event cannot be read by id');
select is_empty($$ select 1 from public.events where community_id = pg_temp.fx('A') $$, '13. ...or by community id');
select is_empty(format($$ select * from public.list_upcoming_events(%L) $$, pg_temp.fx('A')), '13. ...or through list_upcoming_events');
select is_empty(format($$ select * from public.list_events(%L) $$, pg_temp.fx('A')), '13. ...or through list_events');
select is_empty(format($$ select * from public.get_event_attendance(%L) $$, pg_temp.fx('ev_open')), '13. ...or its attendance');
select is_empty($$ select 1 from public.event_rsvps where community_id = pg_temp.fx('A') $$, '13. ...or its RSVPs');
select ok(not public.cancel_rsvp(pg_temp.fx('ev_open')), '13. cancel_rsvp on another community''s event does nothing');
reset role;
select is((select rsvp_changed_at from public.events where id = pg_temp.fx('ev_open')), null::timestamptz, '13. ...and does not even lock or touch that event');
select pg_temp.login(pg_temp.fx('bob'));
with u as (update public.events set status = 'cancelled' where id = pg_temp.fx('ev_open') returning 1)
select is(count(*)::int, 0, '13. the Owner of B cannot cancel A''s event') from u;
select is(
  (select count(*)::int from public.event_rsvps where community_id = pg_temp.fx('B')), 0,
  '13. no RSVP ever landed in B'
);

-- Suspended member, listing, anon --------------------------------------------------
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('m4@A');
select pg_temp.login(pg_temp.fx('m4'));
select throws_like(
  format($$ select * from public.rsvp_to_event(%L, 'going') $$, pg_temp.fx('ev_open')),
  '%row-level security%', 'a suspended member cannot RSVP'
);
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select id from public.list_upcoming_events(%L) $$, pg_temp.fx('A')),
  format($$ values (%L::uuid) $$, pg_temp.fx('ev_open')),
  'upcoming events lists only published events that have not ended'
);
select is(
  (select count(*)::int from public.list_events(pg_temp.fx('A'), null, null, array['published', 'cancelled', 'completed'], 50)), 3,
  'list_events returns published, cancelled and completed events'
);
reset role;
set local role anon;
select throws_ok($$ select * from public.events $$, '42501', null, 'anon cannot read events');
select throws_ok($$ select * from public.rsvp_to_event(gen_random_uuid(), 'going') $$, '42501', null, 'anon cannot RSVP');

select * from finish();
rollback;

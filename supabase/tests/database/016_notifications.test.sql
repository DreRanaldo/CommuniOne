-- Stage 9: notifications: ownership, server-only creation, producers, unread counts, pagination, no cross-tenant leakage.
begin;
create extension if not exists pgtap with schema extensions;

select plan(59);

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

-- Helpers (created as the database owner, before any login).
create function pg_temp.n_count(p_user text, p_type text default null, p_community text default null)
returns integer language sql security definer as $$
  select count(*)::integer from public.notifications
  where user_id = pg_temp.fx(p_user)
    and (p_type is null or type = p_type)
    and (p_community is null or community_id = pg_temp.fx(p_community))
$$;

-- =========================================================================
-- 1. Users receive notifications (announcement fan-out)
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
with i as (
  insert into public.announcements (community_id, title, body, status)
  values (pg_temp.fx('A'), 'Pool reopens', 'The pool reopens Monday.', 'published') returning id
) insert into fx select 'ann', id from i;

select is(pg_temp.n_count('carol', 'announcement', 'A'), 1, '1. a member receives an announcement notification');
select is(pg_temp.n_count('dave', 'announcement', 'A'), 1, '1. every member with announcements.view receives it');
select is(pg_temp.n_count('erin', 'announcement'), 0, '1. the author is not notified about her own announcement');
select is(pg_temp.n_count('grace', 'announcement'), 0, '1. pending members are not notified');
select is(pg_temp.n_count('frank') + pg_temp.n_count('bob'), 0, '10. members of other communities are not notified');

-- =========================================================================
-- 2. Users read their own notifications / 6. unread count
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select type, community_id, title, data ->> 'announcement_id' from public.list_my_notifications() $$,
  $$ values ('announcement', pg_temp.fx('A'), 'Pool reopens', pg_temp.fx('ann')::text) $$,
  '2. a user lists her notifications with community and deep-link data'
);
select is(public.unread_notification_count(), 1, '6. unread count');
insert into fx select 'n_carol', id from public.notifications where user_id = pg_temp.fx('carol') limit 1;
reset role;
insert into fx select 'n_alice', id from public.notifications where user_id = pg_temp.fx('alice') and type = 'announcement' limit 1;

-- =========================================================================
-- 3. Nobody reads another user's notifications
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.notifications where id = pg_temp.fx('n_alice') $$, '3. a user cannot read another user''s notification by id');
select is_empty($$ select 1 from public.notifications where user_id = pg_temp.fx('alice') $$, '3. ...or by filtering on user_id');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.notifications $$, '3. a user from another community sees none of them');
select pg_temp.login(pg_temp.fx('alice'));
select is_empty($$ select 1 from public.notifications where id = pg_temp.fx('n_carol') $$, '3. even a community Owner cannot read a member''s notifications');

-- =========================================================================
-- 4. Mark read / unread / all / archive
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select ok(public.mark_notification_read(pg_temp.fx('n_carol')), '4. a user marks her notification read');
select is(public.unread_notification_count(), 0, '6. unread count drops');
select ok(not public.mark_notification_read(pg_temp.fx('n_carol')), '4. marking it read again is a no-op');
select ok(public.mark_notification_unread(pg_temp.fx('n_carol')), '4. a user marks it unread again');
select is(public.unread_notification_count(), 1, '6. unread count rises again');
update public.notifications set read_at = '2000-01-01' where id = pg_temp.fx('n_carol');
select ok(
  (select read_at > now() - interval '1 minute' from public.notifications where id = pg_temp.fx('n_carol')),
  '4. read_at cannot be back-dated by the client (server time is used)'
);
select ok(public.archive_notification(pg_temp.fx('n_carol')), '4. a user archives a notification');
select is_empty($$ select 1 from public.list_my_notifications() $$, '4. archived notifications are hidden by default');
select is((select count(*)::int from public.list_my_notifications(p_include_archived => true)), 1, '4. ...and listed on request');

-- =========================================================================
-- 5. Nobody modifies another user's notification
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.notifications set read_at = now() where id = pg_temp.fx('n_alice') returning 1)
select is(count(*)::int, 0, '5. a user cannot mark another user''s notification read') from u;
select ok(not public.mark_notification_read(pg_temp.fx('n_alice')), '5. ...not even through the RPC');
with d as (delete from public.notifications where id = pg_temp.fx('n_alice') returning 1)
select is(count(*)::int, 0, '5. a user cannot delete another user''s notification') from d;
select throws_ok(
  format($$ update public.notifications set title = 'Edited' where id = %L $$, pg_temp.fx('n_carol')),
  '42501', null, '5. notification content is not writable, even by its owner'
);
select throws_ok(
  format($$ update public.notifications set user_id = %L where id = %L $$, pg_temp.fx('carol'), pg_temp.fx('n_alice')),
  '42501', null, '5. a notification cannot be re-assigned to another user'
);
select pg_temp.login(pg_temp.fx('alice'));
select is(pg_temp.n_count('alice', 'announcement'), 1, '5. the other user''s notification is untouched');

-- =========================================================================
-- 8. Notification creation is server-controlled
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ insert into public.notifications (user_id, type, title) values (%L, 'system', 'You won!') $$, pg_temp.fx('alice')),
  '42501', null, '8. clients cannot insert notifications'
);
select throws_ok(
  format($$ select public.create_notification(%L, null, 'system', 'You won!') $$, pg_temp.fx('alice')),
  '42501', null, '8. clients cannot call the service RPC'
);
select throws_ok(
  format($$ select private.create_notification(%L, null, 'system', 'You won!') $$, pg_temp.fx('alice')),
  '42501', null, '8. clients cannot call the internal service'
);
select throws_ok(
  format($$ select private.notify_community(%L, 'community.view', 'system', 'Spam', null, '{}', 'x') $$, pg_temp.fx('A')),
  '42501', null, '8. clients cannot call the fan-out service'
);
reset role;
set local role service_role;
select isnt(public.create_notification(pg_temp.fx('carol'), null, 'system', 'Welcome to CommuniOne', null, '{}', 'welcome'), null, '8. trusted server code creates a notification');
select is(public.create_notification(pg_temp.fx('carol'), null, 'system', 'Welcome to CommuniOne', null, '{}', 'welcome'), null, '8. the same dedupe key never notifies twice');
select throws_like(
  format($$ select public.create_notification(%L, %L, 'announcement', 'Leak?') $$, pg_temp.fx('frank'), pg_temp.fx('A')),
  '%not an active member%', '10. even server code cannot send a community notification to a non-member'
);
select throws_like(
  format($$ select public.create_notification(%L, null, 'party', 'x') $$, pg_temp.fx('carol')),
  '%unknown notification type%', '8. unknown notification types are rejected'
);
reset role;

-- =========================================================================
-- 9. Community association (alerts, events, comments, membership)
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'Gas leak', 'Evacuate C', 'emergency', 'published') returning id)
insert into fx select 'alert', id from i;
reset role;
select results_eq(
  $$ select community_id, data ->> 'severity', data ->> 'event' from public.notifications where user_id = pg_temp.fx('carol') and type = 'alert' $$,
  $$ values (pg_temp.fx('A'), 'emergency', 'published') $$,
  '9. an alert notification carries its community and severity'
);
select pg_temp.login(pg_temp.fx('erin'));
update public.alerts set status = 'cancelled' where id = pg_temp.fx('alert');
select is(pg_temp.n_count('carol', 'alert'), 2, '9. withdrawing an alert notifies members again');

select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.events (community_id, title, starts_at, ends_at, status, capacity)
           values (pg_temp.fx('A'), 'Cooking class', now() + interval '3 days', now() + interval '3 days 2 hours', 'published', 1) returning id)
insert into fx select 'event', id from i;
select is(pg_temp.n_count('carol', 'event_created', 'A'), 1, '9. publishing an event notifies members');
select pg_temp.login(pg_temp.fx('carol'));
select * from public.rsvp_to_event(pg_temp.fx('event'), 'going');
select pg_temp.login(pg_temp.fx('dave'));
select * from public.rsvp_to_event(pg_temp.fx('event'), 'going');
select pg_temp.login(pg_temp.fx('carol'));
select public.cancel_rsvp(pg_temp.fx('event'));
reset role;
select results_eq(
  $$ select data ->> 'reason' from public.notifications where user_id = pg_temp.fx('dave') and type = 'event_updated' $$,
  $$ values ('waitlist_promoted') $$,
  '9. a waitlist promotion notifies the promoted member'
);
select pg_temp.login(pg_temp.fx('erin'));
update public.events set status = 'cancelled', cancellation_reason = 'Chef ill' where id = pg_temp.fx('event');
select is(pg_temp.n_count('dave', 'event_cancelled', 'A'), 1, '9. cancelling an event notifies people who RSVP''d');
select is(pg_temp.n_count('carol', 'event_cancelled'), 0, '9. ...but not people who did not');

select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Anyone for tennis?') returning id)
insert into fx select 'post', id from i;
select pg_temp.login(pg_temp.fx('dave'));
with i as (insert into public.comments (post_id, body) values (pg_temp.fx('post'), 'Me!') returning id)
insert into fx select 'comment', id from i;
select pg_temp.login(pg_temp.fx('carol'));
insert into public.comments (post_id, parent_comment_id, body) values (pg_temp.fx('post'), pg_temp.fx('comment'), 'Great, Saturday?');
select is(pg_temp.n_count('carol', 'comment', 'A'), 1, '9. a comment notifies the post author (not for her own reply)');
select is(pg_temp.n_count('dave', 'comment', 'A'), 1, '9. a reply notifies the parent comment''s author');

select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'active' where id = pg_temp.fx('grace@A');
select pg_temp.login(pg_temp.fx('grace'));
select results_eq(
  $$ select type, community_id, title from public.list_my_notifications() $$,
  $$ values ('membership', pg_temp.fx('A'), 'Welcome to Community A') $$,
  '9. an approved member is told about her membership'
);

-- Unread count per community (alice is in A and B)
select pg_temp.login(pg_temp.fx('bob'));
insert into public.announcements (community_id, title, body, status) values (pg_temp.fx('B'), 'B news', 'Only for B', 'published');
select pg_temp.login(pg_temp.fx('alice'));
select is(public.unread_notification_count(pg_temp.fx('B')), 1, '6. unread count filtered by community B');
select is(public.unread_notification_count(pg_temp.fx('A')), public.unread_notification_count() - 1, '6. unread count filtered by community A');
select is(public.mark_all_notifications_read(pg_temp.fx('B')), 1, '4. mark all read in one community');
select is(public.unread_notification_count(pg_temp.fx('B')), 0, '4. ...clears that community');
select ok(public.unread_notification_count(pg_temp.fx('A')) > 0, '4. ...and leaves the others unread');

-- =========================================================================
-- 10. No cross-tenant leakage through notifications
-- =========================================================================
reset role;
select is(
  (select count(*)::int from public.notifications n
   where n.community_id = pg_temp.fx('A')
     and not exists (select 1 from public.memberships m where m.community_id = pg_temp.fx('A') and m.user_id = n.user_id)),
  0, '10. no notification about community A was ever created for a non-member'
);
update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select type from public.list_my_notifications(p_include_archived => true) where community_id is not null order by type $$,
  $$ values ('membership') $$,
  '10. after suspension, community content notifications are no longer readable; the suspension notice is'
);
select is(public.unread_notification_count(pg_temp.fx('A')), 1, '10. unread count no longer includes inaccessible community notifications');
select is_empty(
  format($$ select 1 from public.notifications where data ->> 'alert_id' = %L $$, pg_temp.fx('alert')),
  '10. alert details cannot be read through an old notification'
);
select isnt_empty($$ select 1 from public.notifications where type = 'system' $$, '10. account-level notifications stay readable');

-- =========================================================================
-- 7. Pagination
-- =========================================================================
reset role;
set local role service_role;
select public.create_notification(pg_temp.fx('erin'), null, 'system', 'Notice ' || i) from generate_series(1, 25) as i;
reset role;
select pg_temp.login(pg_temp.fx('erin'));
create temp table npages (page int, id uuid);
grant all on npages to public;
do $$
declare v_at timestamptz; v_id uuid; v_page int := 0; v_n int;
begin
  loop
    v_page := v_page + 1;
    insert into npages select v_page, n.id from public.list_my_notifications(10, v_at, v_id) n;
    get diagnostics v_n = row_count;
    exit when v_n < 10 or v_page > 10;
    select n.created_at, n.id into v_at, v_id from public.list_my_notifications(10, v_at, v_id) n
    order by n.created_at, n.id limit 1;
  end loop;
end;
$$;
select is((select count(distinct id)::int from npages), (select count(*)::int from public.notifications), '7. pages cover every notification exactly once');
select results_eq(
  $$ select page, count(*)::int from npages group by page order by page $$,
  $$ values (1, 10), (2, 10), (3, 5) $$,
  '7. 25 notifications paginate as 10 + 10 + 5 (erin is never notified about her own actions)'
);
select ok((select count(*) from public.list_my_notifications(1000)) <= 100, '7. page size is capped at 100');
select throws_ok($$ select * from public.list_my_notifications(10, now(), null) $$, '22023', null, '7. a partial cursor is rejected');

reset role;
set local role anon;
select throws_ok($$ select * from public.notifications $$, '42501', null, 'anon cannot read notifications');
select throws_ok($$ select public.unread_notification_count() $$, '42501', null, 'anon cannot count notifications');

select * from finish();
rollback;

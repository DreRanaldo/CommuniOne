-- Pre-Stage 12: account deletion policy (personal data removed, community history kept).
begin;
create extension if not exists pgtap with schema extensions;

select plan(39);

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

-- Helpers (owner, before any login)
create function pg_temp.exists_profile(p_user text) returns boolean language sql security definer as $$
  select exists (select 1 from public.profiles where id = pg_temp.fx(p_user))
$$;
create function pg_temp.personal_rows(p_user text) returns integer language sql security definer as $$
  select (select count(*) from public.memberships where user_id = pg_temp.fx(p_user))
       + (select count(*) from public.notifications where user_id = pg_temp.fx(p_user))
       + (select count(*) from public.reactions where user_id = pg_temp.fx(p_user))
       + (select count(*) from public.event_rsvps where user_id = pg_temp.fx(p_user))
       + (select count(*) from public.profile_private where user_id = pg_temp.fx(p_user))
       + (select count(*) from public.platform_admins where user_id = pg_temp.fx(p_user))
       + (select count(*) from auth.sessions where user_id = pg_temp.fx(p_user))
       + (select count(*) from auth.users where id = pg_temp.fx(p_user))
$$;

-- ---------------------------------------------------------------------------
-- Content created by erin (Admin of A) and carol (Member of A)
-- ---------------------------------------------------------------------------
select pg_temp.login(pg_temp.fx('erin'));
insert into public.profile_private (phone) values ('+1 555 0100');
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Erin post') returning id) insert into fx select 'erin_post', id from i;
with i as (insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'Boil water', 'Until Friday', 'urgent', 'published') returning id) insert into fx select 'alert', id from i;
with i as (insert into public.events (community_id, title, starts_at, ends_at, status, capacity) values (pg_temp.fx('A'), 'Cleanup', now() + interval '3 days', now() + interval '3 days 2 hours', 'published', 1) returning id) insert into fx select 'event', id from i;
with i as (insert into public.announcements (community_id, title, body, status) values (pg_temp.fx('A'), 'Notice', 'Body', 'published') returning id) insert into fx select 'ann', id from i;
with i as (insert into public.document_folders (community_id, name) values (pg_temp.fx('A'), 'Erin folder') returning id) insert into fx select 'folder', id from i;
with u as (select * from public.create_document_upload(pg_temp.fx('A'), 'Bylaws.pdf', 'application/pdf', 100, pg_temp.fx('folder'))) insert into fx select 'doc', document_id from u;
insert into storage.objects (bucket_id, name, metadata)
select 'documents', storage_path, '{"size": 100, "mimetype": "application/pdf"}' from public.documents where id = pg_temp.fx('doc');
select public.complete_document_upload(pg_temp.fx('doc'));
with i as (select * from public.create_invitation(pg_temp.fx('A'))) insert into fx select 'invitation', invitation_id from i;

select pg_temp.login(pg_temp.fx('carol'));
insert into public.profile_private (phone) values ('+1 555 0199');
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Carol post') returning id) insert into fx select 'carol_post', id from i;
with i as (insert into public.comments (post_id, body) values (pg_temp.fx('erin_post'), 'Carol comment') returning id) insert into fx select 'carol_comment', id from i;
insert into public.reactions (post_id, reaction_type) values (pg_temp.fx('erin_post'), 'like');
select * from public.rsvp_to_event(pg_temp.fx('event'), 'going');
select pg_temp.login(pg_temp.fx('dave'));
select * from public.rsvp_to_event(pg_temp.fx('event'), 'going');  -- waitlisted (capacity 1)

-- =========================================================================
-- 2. Nobody can delete someone else's account
-- =========================================================================
select is(
  (select pg_get_function_arguments(p.oid) from pg_proc p where p.oid = 'public.delete_my_account()'::regprocedure),
  '', '2. delete_my_account takes no user id: it can only delete the caller'
);
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ delete from auth.users where id = %L $$, pg_temp.fx('erin')), '42501', null, '2. clients cannot delete auth users');
select throws_ok(format($$ delete from public.profiles where id = %L $$, pg_temp.fx('erin')), '42501', null, '2. clients cannot delete profiles');
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok(format($$ delete from public.profiles where id = %L $$, pg_temp.fx('erin')), '42501', null, '2. not even a community Owner');
select ok(pg_temp.exists_profile('erin'), '2. erin''s account is untouched');
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.delete_my_account() $$, '42501', 'authentication required', '2. unauthenticated callers cannot delete anything');
reset role;
set local role anon;
select throws_ok($$ select public.delete_my_account() $$, '42501', null, '2. anon cannot call delete_my_account');
reset role;

-- =========================================================================
-- 1. A user deletes her own account (erin: Admin, creator of community content)
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok($$ select public.delete_my_account() $$, '1. a user deletes her own account');
reset role;

-- 3 / 11. Personal information and personal records are gone
select ok(not pg_temp.exists_profile('erin'), '3. the profile (names, avatar, bio) is deleted');
select is(pg_temp.personal_rows('erin'), 0, '11. no auth record, session, membership, notification, reaction, RSVP, phone or admin grant remains');

-- 12. The deleted user cannot use the application
select pg_temp.login(pg_temp.fx('erin'));
select is(private.current_session_user_id(), null, '12. the old token no longer resolves to a user');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), '12. ...and has no permissions');
select throws_ok($$ select public.create_community('Ghost', 'ghost-town') $$, '42501', null, '12. ...and cannot act');
reset role;

-- 6 / 7 / 8 / announcements / folders: community history is preserved
select results_eq(
  $$ select (select created_by from public.alerts where id = pg_temp.fx('alert')),
            (select published_by from public.alerts where id = pg_temp.fx('alert')),
            (select status from public.alerts where id = pg_temp.fx('alert')) $$,
  $$ values (null::uuid, null::uuid, 'published') $$,
  '6. the alert remains; creator and publisher become NULL ("Deleted User")'
);
select results_eq(
  $$ select created_by, status from public.events where id = pg_temp.fx('event') $$,
  $$ values (null::uuid, 'published') $$,
  '7. the upcoming event remains, now without a creator'
);
select results_eq(
  $$ select uploaded_by, status, folder_id from public.documents where id = pg_temp.fx('doc') $$,
  $$ values (null::uuid, 'active', pg_temp.fx('folder')) $$,
  '8. the document remains active with uploaded_by NULL'
);
select isnt_empty(
  $$ select 1 from storage.objects o join public.documents d on d.storage_path = o.name where d.id = pg_temp.fx('doc') $$,
  '8. the stored file is not deleted'
);
select results_eq(
  $$ select (select author_user_id from public.announcements where id = pg_temp.fx('ann')),
            (select created_by from public.document_folders where id = pg_temp.fx('folder')),
            (select author_user_id from public.posts where id = pg_temp.fx('erin_post')) $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$,
  'announcements, folders and posts keep their content with the creator set to NULL'
);
select results_eq(
  $$ select status, created_by from public.invitations where id = pg_temp.fx('invitation') $$,
  $$ values ('active', null::uuid) $$,
  'the invitation record is kept (and can no longer be redeemed: see 020)'
);

-- 10. Audit history remains usable
select isnt_empty(
  $$ select 1 from public.audit_logs where actor_user_id = pg_temp.fx('erin') and action = 'alert.published' $$,
  '10. earlier audit entries by the deleted user are kept'
);
select results_eq(
  $$ select actor_user_id, entity_id, community_id from public.audit_logs where action = 'account.deleted' and entity_id = pg_temp.fx('erin') $$,
  $$ values (pg_temp.fx('erin'), pg_temp.fx('erin'), null::uuid) $$,
  '10. the deletion itself is audited as a system event'
);
select is_empty(
  $$ select 1 from public.audit_logs where metadata::text ~* '(555 01|Erin post|erin@example)' $$,
  '11. no phone, content or e-mail of the deleted user is held in audit metadata'
);

-- 9. No broken creator references anywhere
select is(
  (select count(*)::int from (
     select author_user_id u from public.posts union all select author_user_id from public.comments
     union all select author_user_id from public.announcements union all select created_by from public.alerts
     union all select created_by from public.events union all select uploaded_by from public.documents
     union all select created_by from public.document_folders union all select created_by from public.invitations
   ) x where u is not null and not exists (select 1 from public.profiles p where p.id = x.u)),
  0, '9. every remaining creator reference points at an existing profile or is NULL'
);

-- 13. Other members still use the history
select pg_temp.login(pg_temp.fx('carol'));
select isnt_empty($$ select 1 from public.posts where id = pg_temp.fx('erin_post') $$, '13. members still read the deleted user''s posts');
select isnt_empty($$ select 1 from public.list_active_alerts(pg_temp.fx('A')) where id = pg_temp.fx('alert') $$, '13. ...see her alert as active');
select isnt_empty(
  $$ select 1 from storage.objects o join public.documents d on d.storage_path = o.name where d.id = pg_temp.fx('doc') $$,
  '13. ...and can still download her document'
);
select results_eq(
  $$ select author_user_id, author_display_name from public.list_community_posts(pg_temp.fx('A')) where id = pg_temp.fx('erin_post') $$,
  $$ values (null::uuid, null::text) $$,
  '13. feeds show a neutral author (NULL id and name → "Deleted User")'
);
select pg_temp.login(pg_temp.fx('alice'));
update public.events set status = 'cancelled' where id = pg_temp.fx('event');
select is((select status from public.events where id = pg_temp.fx('event')), 'cancelled', '7. creator-less events are managed by events.manage holders');

-- =========================================================================
-- 4 / 5. Posts and comments of a deleted member (carol)
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select public.delete_my_account();
reset role;
select results_eq(
  $$ select (select author_user_id from public.posts where id = pg_temp.fx('carol_post')),
            (select author_user_id from public.comments where id = pg_temp.fx('carol_comment')),
            (select body from public.comments where id = pg_temp.fx('carol_comment')) $$,
  $$ values (null::uuid, null::uuid, 'Carol comment') $$,
  '4/5. posts and comments remain with the author set to NULL'
);
select is(pg_temp.personal_rows('carol'), 0, '11. reactions, RSVP and phone of the deleted member are removed');
select results_eq(
  $$ select status from public.event_rsvps where user_id = pg_temp.fx('dave') $$,
  $$ values ('going') $$,
  'the deleted member''s RSVP place went to the waitlist'
);

-- =========================================================================
-- Community continuity
-- =========================================================================
select pg_temp.login(pg_temp.fx('alice'));
select throws_like(
  $$ select public.delete_my_account() $$,
  '%transfer the ability to manage roles%Community A%', 'the only role manager of a community with members must hand over first'
);
select ok(pg_temp.exists_profile('alice'), '...and her account is kept');
select pg_temp.login(pg_temp.fx('frank'));
insert into fx select 'solo', id from public.create_community('Solo club', 'solo-club');
select public.delete_my_account();
reset role;
select is((select status from public.communities where id = pg_temp.fx('solo')), 'archived', 'the last member deleting her account archives the community');
select is((select created_by from public.communities where id = pg_temp.fx('solo')), null::uuid, '...and the community forgets its creator');

-- Suspended accounts can still exercise erasure.
update public.profiles set status = 'suspended' where id = pg_temp.fx('dave');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok($$ select public.delete_my_account() $$, 'a suspended user can still delete her account');
reset role;
select ok(not pg_temp.exists_profile('dave'), '...and it is gone');

-- =========================================================================
-- The erasure exception is narrow: only "creator -> NULL" by the database
-- itself (FK action / owner), never a reassignment and never by a client.
-- =========================================================================
select pg_temp.login(pg_temp.fx('alice'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Still here') returning id) insert into fx select 'alice_post', id from i;
reset role;
set local role service_role;
select throws_ok(format($$ update public.posts set author_user_id = %L where id = %L $$, pg_temp.fx('bob'), pg_temp.fx('alice_post')),
  '42501', null, 'not even the service role can reassign authorship');
reset role;
-- Even if a column grant were added by mistake, a client could not erase
-- their own attribution.
grant update (author_user_id) on public.posts to authenticated;
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok(format($$ update public.posts set author_user_id = null where id = %L $$, pg_temp.fx('alice_post')),
  '42501', null, 'clients cannot clear authorship, even with a mistaken column grant');
reset role;
revoke update (author_user_id) on public.posts from authenticated;

select * from finish();
rollback;

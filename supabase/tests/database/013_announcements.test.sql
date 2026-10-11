-- Stage 6: announcements: lifecycle, permissions, visibility, expiry, cross-tenant attacks, pagination.
begin;
create extension if not exists pgtap with schema extensions;

select plan(52);

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

-- Custom "Announcer" role in A: announcements.view + announcements.create
-- but NOT announcements.manage. Given to dave (Moderator) to test
-- author-only rights. Created by alice (Owner) through the normal API.
select pg_temp.login(pg_temp.fx('alice'));
insert into public.roles (community_id, name) values (pg_temp.fx('A'), 'Announcer');
insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('A', 'Announcer'), id from public.permissions where key in ('announcements.view', 'announcements.create');
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('dave@A'), pg_temp.role_id('A', 'Announcer'));

-- 1. Authorized user creates an announcement (draft) -------------------------
select pg_temp.login(pg_temp.fx('erin'));
with i as (
  insert into public.announcements (community_id, title, body) values (pg_temp.fx('A'), 'Pool closed', 'The pool is closed for repairs.')
  returning id
) insert into fx select 'a_draft', id from i;
select results_eq(
  $$ select status, priority, author_user_id, published_at from public.announcements where id = pg_temp.fx('a_draft') $$,
  $$ values ('draft', 'normal', pg_temp.fx('erin'), null::timestamptz) $$,
  '1. an authorized user saves a draft (author from the session, not yet published)'
);
with i as (
  insert into public.announcements (community_id, title, body, priority, status, expires_at)
  values (pg_temp.fx('A'), 'Water outage', 'Water off Tuesday 9-12.', 'important', 'published', now() + interval '7 days')
  returning id, published_at
) insert into fx select 'a_important', id from i;
select isnt((select published_at from public.announcements where id = pg_temp.fx('a_important')), null, '1. an announcement can be created and published in one step');
select throws_ok(
  format($$ insert into public.announcements (community_id, title, body, status) values (%L, 't', 'b', 'archived') $$, pg_temp.fx('A')),
  null, null, 'new announcements must be draft or published'
);
select throws_ok(
  format($$ insert into public.announcements (community_id, title, body, published_at) values (%L, 't', 'b', now() - interval '1 year') $$, pg_temp.fx('A')),
  '42501', null, 'published_at cannot be supplied by clients'
);
select throws_ok(
  format($$ insert into public.announcements (community_id, title, body, author_user_id) values (%L, 't', 'b', %L) $$, pg_temp.fx('A'), pg_temp.fx('alice')),
  '42501', null, 'author_user_id cannot be supplied by clients'
);
select throws_ok(
  format($$ insert into public.announcements (community_id, title, body, priority) values (%L, 't', 'b', 'urgent') $$, pg_temp.fx('A')),
  '23514', null, 'priority is constrained'
);

-- 2. Normal members (and outsiders) cannot create -----------------------------
select pg_temp.login(pg_temp.fx('carol'));
select throws_like(
  format($$ insert into public.announcements (community_id, title, body) values (%L, 'Hi', 'Member announcement') $$, pg_temp.fx('A')),
  '%row-level security%', '2. a normal member cannot create an announcement'
);
select pg_temp.login(pg_temp.fx('grace'));
select throws_like(
  format($$ insert into public.announcements (community_id, title, body) values (%L, 'Hi', 'Pending') $$, pg_temp.fx('A')),
  '%row-level security%', '2. a pending member cannot create an announcement'
);
select pg_temp.login(pg_temp.fx('alice'));
select throws_like(
  format($$ insert into public.announcements (community_id, title, body) values (%L, 'Hi', 'Owner of A in B') $$, pg_temp.fx('B')),
  '%row-level security%', '10. being Owner of A does not allow announcing in B (changing community_id)'
);

-- 7. Drafts are not visible to normal members -----------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_draft') $$, '7. a draft is not visible to a normal member');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_draft') $$, '7. ...nor to a non-manager author of other announcements');
select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_draft') $$, '7. managers (announcements.manage) see drafts');

-- 4/5. Editing ------------------------------------------------------------------
select pg_temp.login(pg_temp.fx('erin'));
update public.announcements set body = 'The pool is closed for repairs until Friday.' where id = pg_temp.fx('a_draft');
select is((select edited_at from public.announcements where id = pg_temp.fx('a_draft')), null, 'editing a draft does not mark it as edited');

select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.announcements set title = 'Hacked' where id = pg_temp.fx('a_important') returning 1)
select is(count(*)::int, 0, '5. a normal member cannot modify an announcement') from u;
with u as (update public.announcements set status = 'archived' where id = pg_temp.fx('a_important') returning 1)
select is(count(*)::int, 0, '5. a normal member cannot archive an announcement') from u;

select pg_temp.login(pg_temp.fx('dave'));
with u as (update public.announcements set title = 'Not mine' where id = pg_temp.fx('a_important') returning 1)
select is(count(*)::int, 0, '5. announcements.create alone does not allow editing others'' announcements') from u;
with i as (insert into public.announcements (community_id, title, body) values (pg_temp.fx('A'), 'Moderation hours', 'Office hours on Monday.') returning id)
insert into fx select 'a_dave', id from i;
update public.announcements set title = 'Moderator office hours' where id = pg_temp.fx('a_dave');
select is((select title from public.announcements where id = pg_temp.fx('a_dave')), 'Moderator office hours', '4. an author with announcements.create edits her own announcement');

select pg_temp.login(pg_temp.fx('frank'));
with u as (update public.announcements set title = 'From B' where id = pg_temp.fx('a_important') returning 1)
select is(count(*)::int, 0, '9. a user from another community cannot modify an announcement') from u;

-- 3. Publishing -------------------------------------------------------------------
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.announcements set status = 'published', expires_at = now() - interval '1 day' where id = %L $$, pg_temp.fx('a_draft')),
  '%expires_at must be in the future%', 'an announcement cannot be published already expired'
);
update public.announcements set status = 'published' where id = pg_temp.fx('a_draft');
select results_eq(
  $$ select status, published_at is not null, updated_by_user_id from public.announcements where id = pg_temp.fx('a_draft') $$,
  $$ values ('published', true, pg_temp.fx('erin')) $$,
  '3. an authorized user publishes a draft (published_at stamped)'
);
insert into fx values ('a_pool', pg_temp.fx('a_draft'));

select pg_temp.login(pg_temp.fx('alice'));
update public.announcements set title = 'Pool closed until Friday' where id = pg_temp.fx('a_pool');
select results_eq(
  $$ select title, edited_at is not null, updated_by_user_id from public.announcements where id = pg_temp.fx('a_pool') $$,
  $$ values ('Pool closed until Friday', true, pg_temp.fx('alice')) $$,
  '4. a manager edits another author''s published announcement (edited_at, updated_by stamped)'
);
select throws_ok(
  format($$ update public.announcements set published_at = now() - interval '1 year' where id = %L $$, pg_temp.fx('a_pool')),
  '42501', null, 'published_at cannot be rewritten by clients'
);
select throws_ok(
  format($$ update public.announcements set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('a_pool')),
  '42501', null, '10. an announcement cannot be moved to another community'
);

-- 6. Members read published announcements ----------------------------------------
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select id from public.list_current_announcements(%L) $$, pg_temp.fx('A')),
  $$ values (pg_temp.fx('a_important')), (pg_temp.fx('a_pool')) $$,
  '6. a member reads current announcements, important first'
);
select results_eq(
  $$ select title from public.announcements where id = pg_temp.fx('a_pool') $$,
  $$ values ('Pool closed until Friday') $$,
  '6. a member reads an announcement by id'
);

-- 8. Expiration --------------------------------------------------------------------
reset role;
update public.announcements
set published_at = now() - interval '10 days', expires_at = now() - interval '1 day'
where id = pg_temp.fx('a_important');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select id from public.list_current_announcements(%L) $$, pg_temp.fx('A')),
  $$ values (pg_temp.fx('a_pool')) $$,
  '8. an expired announcement is no longer current'
);
select results_eq(
  format($$ select is_expired from public.list_announcement_history(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('a_important')),
  $$ values (true) $$,
  '8. an expired announcement remains in the history, flagged as expired'
);
select isnt_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_important') $$, '8. an expired announcement is still readable by id');
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.announcements set status = 'archived' where id = %L; update public.announcements set status = 'published' where id = %L $$,
         pg_temp.fx('a_important'), pg_temp.fx('a_important')),
  '%expires_at must be in the future%', '8. re-publishing requires a future expiry'
);
update public.announcements set expires_at = now() + interval '30 seconds' where id = pg_temp.fx('a_pool');
select isnt_empty(
  format($$ select 1 from public.list_current_announcements(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('a_pool')),
  '8. an announcement with a future expiry is current'
);

-- Archive / republish / delete ------------------------------------------------------
update public.announcements set status = 'archived' where id = pg_temp.fx('a_pool');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(
  format($$ select 1 from public.list_current_announcements(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('a_pool')),
  'an archived announcement is not current'
);
select results_eq(
  format($$ select status from public.list_announcement_history(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('a_pool')),
  $$ values ('archived') $$,
  'an archived announcement is visible in the history'
);
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ update public.announcements set title = 'edit archived' where id = %L $$, pg_temp.fx('a_pool')),
  '%only draft or published%', 'archived announcements cannot be edited'
);
update public.announcements set status = 'published', expires_at = null where id = pg_temp.fx('a_pool');
select results_eq(
  $$ select status, archived_at from public.announcements where id = pg_temp.fx('a_pool') $$,
  $$ values ('published', null::timestamptz) $$,
  'an archived announcement can be republished'
);
select throws_like(
  format($$ update public.announcements set status = 'draft' where id = %L $$, pg_temp.fx('a_pool')),
  '%invalid announcement transition%', 'invalid transitions are rejected'
);

select pg_temp.login(pg_temp.fx('dave'));
update public.announcements set status = 'deleted' where id = pg_temp.fx('a_dave');
select is((select status from public.announcements where id = pg_temp.fx('a_dave')), 'deleted', 'an author soft-deletes her own announcement');
select throws_like(
  format($$ update public.announcements set status = 'draft' where id = %L $$, pg_temp.fx('a_dave')),
  '%deleted announcements cannot be modified%', 'deleted is terminal'
);
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_dave') $$, 'deleted announcements are invisible to members');
select is_empty(
  format($$ select 1 from public.list_announcement_history(%L, 50, null, null, array['deleted', 'draft']) $$, pg_temp.fx('A')),
  'members cannot list deleted or draft announcements'
);
select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty(
  format($$ select 1 from public.list_announcement_history(%L, 50, null, null, array['deleted']) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('a_dave')),
  'managers can list deleted announcements'
);
select throws_ok(
  format($$ delete from public.announcements where id = %L $$, pg_temp.fx('a_pool')),
  '42501', null, 'announcements cannot be hard-deleted by clients'
);

-- 9/10. Cross-community ----------------------------------------------------------------
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.announcements where id = pg_temp.fx('a_pool') $$, '9. a user cannot read another community''s announcement by id');
select is_empty($$ select 1 from public.announcements where community_id = pg_temp.fx('A') $$, '10. ...or by filtering on its community id');
select is_empty(format($$ select * from public.list_current_announcements(%L) $$, pg_temp.fx('A')), '10. ...or by passing its community id to the list functions');
select is_empty(format($$ select * from public.list_announcement_history(%L) $$, pg_temp.fx('A')), '10. ...including the history');
select pg_temp.login(pg_temp.fx('bob'));
with u as (update public.announcements set status = 'archived' where id = pg_temp.fx('a_pool') returning 1)
select is(count(*)::int, 0, '9. the Owner of B cannot manage A''s announcements') from u;

-- Suspended members ------------------------------------------------------------------------
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.announcements $$, 'a suspended member cannot read announcements');

-- Pagination ---------------------------------------------------------------------------------
select pg_temp.login(pg_temp.fx('erin'));
insert into public.announcements (community_id, title, body, status, priority)
select pg_temp.fx('A'), 'Bulk ' || i, 'Bulk body', 'published', case when i % 3 = 0 then 'important' else 'normal' end
from generate_series(1, 12) as i;
create temp table apages (page int, id uuid);
grant all on apages to public;
do $$
declare v_p text; v_at timestamptz; v_id uuid; v_page int := 0; v_n int;
begin
  loop
    v_page := v_page + 1;
    insert into apages select v_page, a.id from public.list_current_announcements(pg_temp.fx('A'), 5, v_p, v_at, v_id) a;
    get diagnostics v_n = row_count;
    exit when v_n < 5 or v_page > 10;
    select a.priority, a.published_at, a.id into v_p, v_at, v_id
    from public.list_current_announcements(pg_temp.fx('A'), 5, v_p, v_at, v_id) a
    order by (a.priority = 'important')::int, a.published_at, a.id limit 1;
  end loop;
end;
$$;
select is((select count(*)::int from apages), 13, 'current announcements paginate across pages (12 bulk + 1)');
select is((select count(distinct id)::int from apages), 13, 'no announcement is duplicated across pages');
select results_eq(
  $$ select p.page, count(*) filter (where a.priority = 'important')::int
     from apages p join public.announcements a on a.id = p.id group by p.page order by p.page $$,
  $$ values (1, 4), (2, 0), (3, 0) $$,
  'all four important announcements come first (page 1), none later'
);
select throws_ok(
  format($$ select * from public.list_current_announcements(%L, 5, 'normal', null, null) $$, pg_temp.fx('A')),
  '22023', null, 'a partial cursor is rejected'
);

-- Unauthenticated -------------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$ select * from public.announcements $$, '42501', null, 'anon cannot read announcements');

select * from finish();
rollback;

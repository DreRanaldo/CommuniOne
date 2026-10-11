-- Pre-Stage 12: systematic cross-tenant sweep over every community-scoped table and RPC.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

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

-- Systematic cross-tenant sweep. Content is created in Community A across
-- every feature; then frank (Member of B only) and grace (pending in A) must
-- see NONE of it through any table or RPC.

select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'A post') returning id) insert into fx select 'post', id from i;
with i as (insert into public.comments (post_id, body) values (pg_temp.fx('post'), 'A comment') returning id) insert into fx select 'comment', id from i;
insert into public.reactions (post_id, reaction_type) values (pg_temp.fx('post'), 'like');
insert into public.announcements (community_id, title, body, status) values (pg_temp.fx('A'), 'A news', 'Body', 'published');
insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'A alert', 'Body', 'warning', 'published');
with i as (insert into public.events (community_id, title, starts_at, ends_at, status) values (pg_temp.fx('A'), 'A event', now() + interval '1 day', now() + interval '1 day 1 hour', 'published') returning id) insert into fx select 'event', id from i;
select * from public.rsvp_to_event(pg_temp.fx('event'), 'going');
insert into public.document_folders (community_id, name) values (pg_temp.fx('A'), 'A folder');
with u as (select * from public.create_document_upload(pg_temp.fx('A'), 'A.pdf', 'application/pdf', 10)) insert into fx select 'doc', document_id from u;
insert into storage.objects (bucket_id, name, metadata) select 'documents', storage_path, '{"size": 10, "mimetype": "application/pdf"}' from public.documents where id = pg_temp.fx('doc');
select public.complete_document_upload(pg_temp.fx('doc'));
select * from public.create_invitation(pg_temp.fx('A'));

-- Every public table with a community_id column, plus the visible row count
-- for community A, as the current user.
create function pg_temp.visible_a_rows() returns table (tbl text, n bigint) language plpgsql as $$
declare r record;
begin
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'community_id'
    order by c.table_name
  loop
    begin
      execute format('select count(*) from public.%I where community_id = %L', r.table_name, pg_temp.fx('A')) into n;
    exception when insufficient_privilege then
      n := 0;  -- no privilege at all is also "nothing visible"
    end;
    tbl := r.table_name;
    return next;
  end loop;
end;
$$;

reset role;
select ok((select count(*) from pg_temp.visible_a_rows()) >= 15, 'the sweep covers every community-scoped table (' || (select count(*) from pg_temp.visible_a_rows()) || ' tables)');

select pg_temp.login(pg_temp.fx('carol'));
select ok((select count(*) from pg_temp.visible_a_rows() where n > 0) >= 10, 'sanity: a member of A does see A data in many tables');

select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select tbl || ': ' || n from pg_temp.visible_a_rows() where n > 0 $$, 'a Member of B sees no row of community A in any table');
select is_empty($$ select 1 from storage.objects where bucket_id = 'documents' $$, 'a Member of B sees no stored file of A');
select is_empty($$ select 1 from public.profiles where id in (pg_temp.fx('carol'), pg_temp.fx('erin'), pg_temp.fx('dave')) $$, 'a Member of B sees no A-only profiles');
select is_empty($$ select 1 from public.notifications $$, 'a Member of B has no notifications about A');

-- Every list / read RPC, given A's ids
select is_empty(format($$ select * from public.list_community_posts(%L) $$, pg_temp.fx('A')), 'RPC list_community_posts');
select is_empty(format($$ select * from public.list_post_comments(%L) $$, pg_temp.fx('post')), 'RPC list_post_comments');
select is_empty(format($$ select * from public.get_reaction_summary(array[%L]::uuid[]) $$, pg_temp.fx('post')), 'RPC get_reaction_summary');
select is_empty(format($$ select * from public.list_current_announcements(%L) $$, pg_temp.fx('A')), 'RPC list_current_announcements');
select is_empty(format($$ select * from public.list_announcement_history(%L) $$, pg_temp.fx('A')), 'RPC list_announcement_history');
select is_empty(format($$ select * from public.list_active_alerts(%L) $$, pg_temp.fx('A')), 'RPC list_active_alerts');
select is_empty(format($$ select * from public.list_alert_history(%L) $$, pg_temp.fx('A')), 'RPC list_alert_history');
select is_empty(format($$ select * from public.list_upcoming_events(%L) $$, pg_temp.fx('A')), 'RPC list_upcoming_events');
select is_empty(format($$ select * from public.list_events(%L) $$, pg_temp.fx('A')), 'RPC list_events');
select is_empty(format($$ select * from public.get_event_attendance(%L) $$, pg_temp.fx('event')), 'RPC get_event_attendance');
select is_empty(format($$ select * from public.list_documents(%L) $$, pg_temp.fx('A')), 'RPC list_documents');
select is_empty(format($$ select * from public.list_audit_logs(%L) $$, pg_temp.fx('A')), 'RPC list_audit_logs');
select is_empty(format($$ select * from public.list_invitations(%L, true) $$, pg_temp.fx('A')), 'RPC list_invitations');
select is_empty(format($$ select * from public.my_community_permissions(%L) $$, pg_temp.fx('A')), 'RPC my_community_permissions');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'community.view'), 'RPC has_community_permission');
select is_empty($$ select 1 from public.my_communities() where community_id = pg_temp.fx('A') $$, 'RPC my_communities');
select ok(not public.cancel_rsvp(pg_temp.fx('event')), 'RPC cancel_rsvp is a no-op on A''s event');
select throws_ok(format($$ select * from public.rsvp_to_event(%L, 'going') $$, pg_temp.fx('event')), '42501', null, 'RPC rsvp_to_event refuses A''s event');
select throws_ok(format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 1) $$, pg_temp.fx('A')), '42501', null, 'RPC create_document_upload refuses A');
select throws_ok(format($$ select * from public.create_invitation(%L) $$, pg_temp.fx('A')), '42501', null, 'RPC create_invitation refuses A');

-- A pending applicant of A is equally blind.
select pg_temp.login(pg_temp.fx('grace'));
select is_empty($$ select tbl || ': ' || n from pg_temp.visible_a_rows() where n > 0 and tbl not in ('memberships', 'audit_logs') $$, 'a pending member of A sees no community content');

-- Structural guarantees
reset role;
select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and has_function_privilege('anon', p.oid, 'execute') $$,
  'anon can execute no CommuniOne function'
);
select is_empty(
  $$ select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'references')
          or has_table_privilege('authenticated', c.oid, 'trigger')) $$,
  'clients hold no TRUNCATE / REFERENCES / TRIGGER privilege on any table'
);
select is_empty(
  $$ select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and has_table_privilege('authenticated', c.oid, 'insert')
     and c.relname in ('communities', 'memberships', 'audit_logs', 'alert_events', 'notifications', 'invitations', 'documents') $$,
  'tables written only by server functions grant no INSERT to clients'
);

select * from finish();
rollback;

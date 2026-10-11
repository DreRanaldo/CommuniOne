-- Stage 11: audit logs: producers, actor/community, access control, append-only, impersonation, redaction.
begin;
create extension if not exists pgtap with schema extensions;

select plan(44);

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

-- Helper (created as the database owner): latest entry for an action.
create function pg_temp.last_audit(p_action text)
returns table (community_id uuid, actor_user_id uuid, entity_id uuid, metadata jsonb)
language sql security definer as $$
  select community_id, actor_user_id, entity_id, metadata from public.audit_logs
  where action = p_action order by created_at desc, id desc limit 1
$$;

-- =========================================================================
-- 1-3. Administrative actions create audit records with actor and community
-- =========================================================================
select results_eq(
  $$ select community_id, actor_user_id, metadata ->> 'slug' from public.audit_logs
     where action = 'community.created' and entity_id = pg_temp.fx('A') $$,
  $$ values (pg_temp.fx('A'), pg_temp.fx('alice'), 'community-a') $$,
  '1-3. creating a community is audited with its creator and community'
);
select results_eq(
  $$ select actor_user_id, metadata ->> 'role_name' from public.audit_logs
     where action = 'role.assigned' and community_id = pg_temp.fx('A') and (metadata ->> 'user_id')::uuid = pg_temp.fx('alice') $$,
  $$ values (pg_temp.fx('alice'), 'Owner') $$,
  '1. the creator receiving the Owner role is audited'
);
select is(
  (select count(*)::int from public.audit_logs where action = 'permission.assigned' and community_id = pg_temp.fx('A')), 0,
  '1. copying default role permissions at creation does not flood the log'
);

select pg_temp.login(pg_temp.fx('erin'));
update public.memberships set status = 'suspended' where id = pg_temp.fx('carol@A');
select results_eq(
  $$ select community_id, actor_user_id, entity_id, metadata ->> 'user_id', metadata ->> 'from', metadata ->> 'to'
     from pg_temp.last_audit('membership.suspended') $$,
  $$ values (pg_temp.fx('A'), pg_temp.fx('erin'), pg_temp.fx('carol@A'), pg_temp.fx('carol')::text, 'active', 'suspended') $$,
  '1-3. suspending a member records the actor (admin), community, membership and transition'
);
update public.memberships set status = 'active' where id = pg_temp.fx('carol@A');
select is((select actor_user_id from pg_temp.last_audit('membership.reinstated')), pg_temp.fx('erin'), '1. reinstatement is audited');

select pg_temp.login(pg_temp.fx('alice'));
update public.memberships set status = 'active' where id = pg_temp.fx('grace@A');
select is((select entity_id from pg_temp.last_audit('membership.approved')), pg_temp.fx('grace@A'), '1. approval is audited');
insert into public.roles (community_id, name) values (pg_temp.fx('A'), 'Treasurer');
insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('A', 'Treasurer'), id from public.permissions where key = 'documents.manage';
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Treasurer'));
select results_eq(
  $$ select action, community_id, actor_user_id from public.audit_logs
     where action in ('role.created', 'permission.assigned', 'role.assigned') and created_at > now() - interval '1 hour'
       and community_id = pg_temp.fx('A') and actor_user_id = pg_temp.fx('alice')
       and (action <> 'role.assigned' or (metadata ->> 'role_name') = 'Treasurer')
     order by created_at $$,
  $$ values ('role.created', pg_temp.fx('A'), pg_temp.fx('alice')),
            ('permission.assigned', pg_temp.fx('A'), pg_temp.fx('alice')),
            ('role.assigned', pg_temp.fx('A'), pg_temp.fx('alice')) $$,
  '1. role creation, permission grant and role assignment are each audited'
);
delete from public.membership_roles where membership_id = pg_temp.fx('carol@A') and role_id = pg_temp.role_id('A', 'Treasurer');
delete from public.roles where id = pg_temp.role_id('A', 'Treasurer');
select is(
  (select array_agg(action order by created_at) from public.audit_logs
   where action in ('role.unassigned', 'role.deleted', 'permission.removed') and created_at > now() - interval '1 hour'),
  array['role.unassigned', 'role.deleted'],
  '1. unassignment and deletion are audited; the cascade does not add noise'
);
update public.communities set description = 'Updated', settings = '{"theme": "blue"}' where id = pg_temp.fx('A');
select is((select metadata -> 'changed_fields' from pg_temp.last_audit('community.updated')), '["description", "settings"]'::jsonb,
  '1. community updates record which fields changed (not their values)');

-- Moderation, announcements, alerts, events, documents
select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Private thoughts about my neighbours') returning id)
insert into fx select 'post', id from i;
select pg_temp.login(pg_temp.fx('dave'));
update public.posts set status = 'hidden', moderation_reason = 'Off topic' where id = pg_temp.fx('post');
select results_eq(
  $$ select actor_user_id, metadata ->> 'author_user_id', metadata ->> 'to', metadata ->> 'reason', metadata ? 'body'
     from pg_temp.last_audit('post.moderated') $$,
  $$ values (pg_temp.fx('dave'), pg_temp.fx('carol')::text, 'hidden', 'Off topic', false) $$,
  '1. moderating a post is audited (without copying the post body)'
);
select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Delete me') returning id)
insert into fx select 'own_post', id from i;
update public.posts set status = 'deleted' where id = pg_temp.fx('own_post');
select is((select count(*)::int from public.audit_logs where entity_id = pg_temp.fx('own_post')), 0,
  '1. authors deleting their own posts is not moderation and is not audited');

select pg_temp.login(pg_temp.fx('erin'));
insert into public.alerts (community_id, title, body, severity, status) values (pg_temp.fx('A'), 'Gas leak', 'Evacuate', 'emergency', 'published');
select results_eq(
  $$ select actor_user_id, metadata ->> 'severity' from pg_temp.last_audit('alert.published') $$,
  $$ values (pg_temp.fx('erin'), 'emergency') $$,
  '1. publishing an emergency alert is audited with its severity'
);
insert into public.announcements (community_id, title, body, status) values (pg_temp.fx('A'), 'News', 'Body', 'published');
select is((select actor_user_id from pg_temp.last_audit('announcement.published')), pg_temp.fx('erin'), '1. publishing an announcement is audited');
with i as (insert into public.events (community_id, title, starts_at, ends_at, status) values (pg_temp.fx('A'), 'Fair', now() + interval '2 days', now() + interval '2 days 1 hour', 'published') returning id)
insert into fx select 'event', id from i;
update public.events set status = 'cancelled', cancellation_reason = 'Rain' where id = pg_temp.fx('event');
select results_eq(
  $$ select entity_id, metadata ->> 'reason' from pg_temp.last_audit('event.cancelled') $$,
  $$ values (pg_temp.fx('event'), 'Rain') $$,
  '1. cancelling an event is audited'
);
with u as (select * from public.create_document_upload(pg_temp.fx('A'), 'Minutes.pdf', 'application/pdf', 100))
insert into fx select 'doc', document_id from u;
insert into storage.objects (bucket_id, name, metadata)
select 'documents', storage_path, '{"size": 100, "mimetype": "application/pdf"}' from public.documents where id = pg_temp.fx('doc');
select public.complete_document_upload(pg_temp.fx('doc'));
update public.documents set status = 'deleted' where id = pg_temp.fx('doc');
select is(
  (select array_agg(action order by created_at) from public.audit_logs where entity_id = pg_temp.fx('doc')),
  array['document.uploaded', 'document.deleted'],
  '1. document upload and deletion are audited'
);

-- System event (no community): platform admin changes an account status.
reset role;
insert into public.platform_admins (user_id) values (pg_temp.fx('bob'));
select pg_temp.login(pg_temp.fx('bob'));
select public.admin_set_account_status(pg_temp.fx('frank'), 'suspended');
select results_eq(
  $$ select community_id, actor_user_id, entity_id, metadata ->> 'to' from pg_temp.last_audit('account.status_changed') $$,
  $$ values (null::uuid, pg_temp.fx('bob'), pg_temp.fx('frank'), 'suspended') $$,
  '1-3. platform account actions are system events (no community) with the admin as actor'
);
select isnt_empty($$ select 1 from public.list_audit_logs(null) where action = 'account.status_changed' $$, 'platform admins can read system events');
select public.admin_set_account_status(pg_temp.fx('frank'), 'active');

-- =========================================================================
-- 4. Unauthorized users cannot read audit logs / 7. cross-community
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select isnt_empty(format($$ select * from public.list_audit_logs(%L) $$, pg_temp.fx('A')), '4. an admin with audit.view reads her community''s audit log');
select is_empty($$ select 1 from public.audit_logs where community_id is null $$, '4. community admins cannot read system events');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.audit_logs $$, '4. a member without audit.view reads nothing');
select is_empty($$ select 1 from public.audit_logs where (metadata ->> 'user_id')::uuid = pg_temp.fx('carol') $$, '4. ...not even entries about herself');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty(format($$ select * from public.list_audit_logs(%L) $$, pg_temp.fx('A')), '4. a moderator without audit.view reads nothing');
select pg_temp.login(pg_temp.fx('bob'));
select is_empty($$ select 1 from public.audit_logs where community_id = pg_temp.fx('A') $$, '7. the Owner of B cannot read A''s audit log');
select is_empty(format($$ select * from public.list_audit_logs(%L) $$, pg_temp.fx('A')), '7. ...through the list function either');
select isnt_empty(format($$ select * from public.list_audit_logs(%L) $$, pg_temp.fx('B')), '7. ...while reading his own community''s log');
select pg_temp.login(pg_temp.fx('alice'));
select is_empty($$ select 1 from public.audit_logs where community_id = pg_temp.fx('B') $$, '7. Owner of A (a Member of B) cannot read B''s audit log');
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('erin@A');
select pg_temp.login(pg_temp.fx('erin'));
select is_empty($$ select 1 from public.audit_logs $$, '4. a suspended admin loses audit access immediately');

-- =========================================================================
-- 5. Audit logs cannot be modified / 6. actors cannot be impersonated
-- =========================================================================
select pg_temp.login(pg_temp.fx('alice'));
select throws_ok($$ update public.audit_logs set action = 'community.updated' $$, '42501', null, '5. an Owner cannot update audit logs');
select throws_ok($$ delete from public.audit_logs $$, '42501', null, '5. an Owner cannot delete audit logs');
select throws_ok(
  format($$ insert into public.audit_logs (community_id, actor_user_id, action, entity_type) values (%L, %L, 'community.updated', 'community') $$,
         pg_temp.fx('A'), pg_temp.fx('bob')),
  '42501', null, '6. clients cannot insert audit entries (no forged actor)'
);
select throws_ok(
  format($$ select private.record_audit_event(%L, 'community.updated', 'community', null) $$, pg_temp.fx('A')),
  '42501', null, '6. clients cannot call the internal audit service'
);
select throws_ok(
  format($$ select public.record_system_audit_event(%L, 'community.updated', 'community') $$, pg_temp.fx('A')),
  '42501', null, '6. clients cannot record system events'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'record_audit_event' and pg_get_function_arguments(p.oid) ilike '%actor%'),
  0, '6. the audit service has no actor parameter: the actor always comes from the session'
);
reset role;
set local role service_role;
select throws_ok($$ update public.audit_logs set metadata = '{}' $$, '42501', null, '5. even the service role cannot update audit logs');
select throws_ok($$ delete from public.audit_logs $$, '42501', null, '5. even the service role cannot delete audit logs directly');
select throws_like($$ select public.purge_audit_logs(interval '1 day') $$, '%at least 90 days%', '5. retention purge keeps at least 90 days');
select is(public.purge_audit_logs(interval '365 days'), 0, '5. the retention purge (service role) only removes old entries');
reset role;
select throws_like($$ update public.audit_logs set action = 'community.updated' $$, '%append-only%', '5. even the database owner cannot rewrite history');
select throws_like($$ truncate public.audit_logs $$, '%append-only%', '5. TRUNCATE is refused');

-- =========================================================================
-- 8. Sensitive credentials are never stored
-- =========================================================================
set local role service_role;
select public.record_system_audit_event(null, 'account.status_changed', 'profile', pg_temp.fx('carol'), jsonb_build_object(
  'password', 'hunter2', 'api_key', 'sk_live_123', 'Authorization', 'Bearer abc.def',
  'nested', jsonb_build_object('access_token', 'eyJ...', 'refresh_token', 'r1', 'note', 'kept'),
  'items', jsonb_build_array(jsonb_build_object('card_number', '4111111111111111', 'cvv', '123', 'shipping', 'kept')),
  'invitation_secret', 's3cr3t', 'reason', 'kept'));
reset role;
select results_eq(
  $$ select metadata from pg_temp.last_audit('account.status_changed') $$,
  $$ values (jsonb_build_object(
       'password', '[redacted]', 'api_key', '[redacted]', 'Authorization', '[redacted]',
       'nested', jsonb_build_object('access_token', '[redacted]', 'refresh_token', '[redacted]', 'note', 'kept'),
       'items', jsonb_build_array(jsonb_build_object('card_number', '[redacted]', 'cvv', '[redacted]', 'shipping', 'kept')),
       'invitation_secret', '[redacted]', 'reason', 'kept')) $$,
  '8. credential-like keys are redacted at any depth; ordinary keys are kept'
);
select is_empty(
  $$ select 1 from public.audit_logs where metadata::text ~* '(hunter2|sk_live|bearer abc|4111111111111111)' $$,
  '8. no secret value is stored anywhere in the audit log'
);
select is_empty(
  $$ select 1 from public.audit_logs where metadata::text ilike '%Private thoughts%' $$,
  '8. content bodies are never copied into audit metadata'
);

-- Pagination
select pg_temp.login(pg_temp.fx('bob'));
create temp table apages (page int, id uuid);
grant all on apages to public;
do $$
declare v_at timestamptz; v_id uuid; v_page int := 0; v_n int;
begin
  loop
    v_page := v_page + 1;
    insert into apages select v_page, a.id from public.list_audit_logs(pg_temp.fx('B'), 2, v_at, v_id) a;
    get diagnostics v_n = row_count;
    exit when v_n < 2 or v_page > 50;
    select a.created_at, a.id into v_at, v_id from public.list_audit_logs(pg_temp.fx('B'), 2, v_at, v_id) a
    order by a.created_at, a.id limit 1;
  end loop;
end;
$$;
select is((select count(distinct id)::int from apages), (select count(*)::int from public.audit_logs where community_id = pg_temp.fx('B')),
  'audit logs paginate: every entry exactly once');

reset role;
set local role anon;
select throws_ok($$ select * from public.audit_logs $$, '42501', null, 'anon cannot read audit logs');

select * from finish();
rollback;

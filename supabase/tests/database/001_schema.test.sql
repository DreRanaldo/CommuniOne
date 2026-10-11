-- Structural checks: tables, RLS, constraints, foreign keys, indexes,
-- privileges, seeded reference data.
begin;
create extension if not exists pgtap with schema extensions;

select plan(67);

-- Tables --------------------------------------------------------------------
select has_table('public', t, 'table public.' || t || ' exists')
from unnest(array[
  'profiles', 'communities', 'memberships', 'roles', 'permissions',
  'membership_roles', 'role_permissions', 'role_templates', 'role_template_permissions',
  'platform_admins', 'posts', 'comments', 'reactions', 'announcements',
  'alerts', 'alert_events', 'events', 'event_rsvps', 'notifications', 'notification_types'
]) as t;

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'RLS is enabled on every public table'
);

select hasnt_column('public', 'profiles', 'email',    'profiles does not duplicate auth email');
select hasnt_column('public', 'profiles', 'password', 'profiles stores no password');

-- Unique constraints / keys --------------------------------------------------
select col_is_unique('public', 'communities', array['slug'], 'communities.slug is unique');
select col_is_unique('public', 'memberships', array['community_id', 'user_id'], 'one membership per (community, user)');
select col_is_unique('public', 'membership_roles', array['membership_id', 'role_id'], 'no duplicate role assignment');
select col_is_unique('public', 'permissions', array['key'], 'permissions.key is unique');
select col_is_pk('public', 'role_permissions', array['role_id', 'permission_id'], 'role_permissions PK(role_id, permission_id)');

-- Foreign keys and ON DELETE behaviour ---------------------------------------
-- confdeltype: a = no action, r = restrict, c = cascade, n = set null
select results_eq(
  $$ select conrelid::regclass::text, conname::text collate "default", confrelid::regclass::text, confdeltype::text
     from pg_constraint
     where contype = 'f' and connamespace = 'public'::regnamespace
     order by 1, 2 $$,
  $$ values
     ('alert_events',              'alert_events_actor_user_id_fkey',                'profiles',                  'n'),
     ('alert_events',              'alert_events_alert_id_fkey',                     'alerts',                    'c'),
     ('alert_events',              'alert_events_community_id_fkey',                 'communities',               'r'),
     ('alerts',                    'alerts_cancelled_by_fkey',                       'profiles',                  'n'),
     ('alerts',                    'alerts_community_id_fkey',                       'communities',               'r'),
     ('alerts',                    'alerts_created_by_fkey',                         'profiles',                  'r'),
     ('alerts',                    'alerts_published_by_fkey',                       'profiles',                  'n'),
     ('alerts',                    'alerts_updated_by_user_id_fkey',                 'profiles',                  'n'),
     ('announcements',             'announcements_author_user_id_fkey',              'profiles',                  'n'),
     ('announcements',             'announcements_community_id_fkey',                'communities',               'r'),
     ('announcements',             'announcements_updated_by_user_id_fkey',          'profiles',                  'n'),
     ('comments',                  'comments_author_user_id_fkey',                   'profiles',                  'c'),
     ('comments',                  'comments_moderated_by_user_id_fkey',             'profiles',                  'n'),
     ('comments',                  'comments_parent_fk',                             'comments',                  'n'),
     ('comments',                  'comments_post_fk',                               'posts',                     'c'),
     ('communities',               'communities_created_by_fkey',                    'auth.users',                'n'),
     ('event_rsvps',               'event_rsvps_event_fk',                           'events',                    'c'),
     ('event_rsvps',               'event_rsvps_user_id_fkey',                       'profiles',                  'c'),
     ('events',                    'events_cancelled_by_fkey',                       'profiles',                  'n'),
     ('events',                    'events_community_id_fkey',                       'communities',               'r'),
     ('events',                    'events_created_by_fkey',                         'profiles',                  'r'),
     ('events',                    'events_updated_by_user_id_fkey',                 'profiles',                  'n'),
     ('membership_roles',          'membership_roles_membership_fk',                 'memberships',               'c'),
     ('membership_roles',          'membership_roles_role_fk',                       'roles',                     'r'),
     ('memberships',               'memberships_community_id_fkey',                  'communities',               'r'),
     ('memberships',               'memberships_user_id_fkey',                       'auth.users',                'c'),
     ('memberships',               'memberships_user_profile_fkey',                  'profiles',                  'c'),
     ('notifications',             'notifications_community_id_fkey',                'communities',               'c'),
     ('notifications',             'notifications_type_fkey',                        'notification_types',        'r'),
     ('notifications',             'notifications_user_id_fkey',                     'profiles',                  'c'),
     ('platform_admins',           'platform_admins_granted_by_fkey',                'auth.users',                'n'),
     ('platform_admins',           'platform_admins_user_id_fkey',                   'auth.users',                'c'),
     ('posts',                     'posts_author_user_id_fkey',                      'profiles',                  'c'),
     ('posts',                     'posts_community_id_fkey',                        'communities',               'r'),
     ('posts',                     'posts_moderated_by_user_id_fkey',                'profiles',                  'n'),
     ('profiles',                  'profiles_id_fkey',                               'auth.users',                'c'),
     ('reactions',                 'reactions_comment_fk',                           'comments',                  'c'),
     ('reactions',                 'reactions_post_fk',                              'posts',                     'c'),
     ('reactions',                 'reactions_user_id_fkey',                         'profiles',                  'c'),
     ('role_permissions',          'role_permissions_permission_id_fkey',            'permissions',               'r'),
     ('role_permissions',          'role_permissions_role_id_fkey',                  'roles',                     'c'),
     ('role_template_permissions', 'role_template_permissions_permission_id_fkey',   'permissions',               'r'),
     ('role_template_permissions', 'role_template_permissions_template_id_fkey',     'role_templates',            'c'),
     ('roles',                     'roles_community_id_fkey',                        'communities',               'r') $$,
  'foreign keys exist with the intended ON DELETE behaviour'
);

-- Indexes (each required access pattern is served by an index whose
-- leading column(s) match) -----------------------------------------------------
select ok(exists (
  select 1 from pg_index i
  where i.indrelid = format('public.%I', t.tbl)::regclass
    and (select array_agg(a.attname::text order by k.ord)
         from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where k.ord <= cardinality(t.cols)) = t.cols
), format('index leads with %s(%s)', t.tbl, array_to_string(t.cols, ', ')))
from (values
  ('communities',      array['slug']),
  ('memberships',      array['community_id']),
  ('memberships',      array['user_id']),
  ('memberships',      array['community_id', 'status']),
  ('roles',            array['community_id']),
  ('membership_roles', array['membership_id']),
  ('membership_roles', array['role_id']),
  ('role_permissions', array['role_id']),
  ('posts',            array['community_id', 'created_at', 'id']),
  ('comments',         array['post_id', 'created_at', 'id']),
  ('comments',         array['parent_comment_id', 'created_at', 'id']),
  ('reactions',        array['post_id', 'user_id']),
  ('reactions',        array['comment_id', 'user_id']),
  ('reactions',        array['user_id']),
  ('announcements',    array['community_id', 'status', 'published_at']),
  ('announcements',    array['community_id', 'expires_at']),
  ('alerts',           array['community_id', 'status', 'published_at']),
  ('alerts',           array['expires_at']),
  ('alert_events',     array['alert_id', 'occurred_at']),
  ('events',           array['community_id', 'starts_at']),
  ('events',           array['community_id', 'status', 'starts_at']),
  ('event_rsvps',      array['event_id']),
  ('event_rsvps',      array['user_id']),
  ('notifications',    array['user_id', 'created_at']),
  ('notifications',    array['user_id', 'read_at']),
  ('notifications',    array['community_id', 'created_at'])
) as t(tbl, cols);

-- Privileges -----------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (has_table_privilege('anon', c.oid, 'select')
         or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update')
         or has_table_privilege('anon', c.oid, 'delete')) $$,
  'anon has no privileges on any public table'
);

select ok(not has_table_privilege('authenticated', 'public.communities', 'insert'), 'clients cannot insert communities directly');
select ok(not has_table_privilege('authenticated', 'public.memberships', 'insert'), 'clients cannot insert memberships directly');
select ok(not has_column_privilege('authenticated', 'public.communities', 'status', 'update'), 'clients cannot change community status');
select ok(not has_column_privilege('authenticated', 'public.roles', 'is_system_role', 'insert'), 'clients cannot create system roles');
select ok(not has_function_privilege('anon', 'public.create_community(text, text, text, text, text)', 'execute'), 'anon cannot call create_community');

select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p
     where p.prosecdef
       and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'every SECURITY DEFINER function pins search_path to empty'
);

-- Seeded permissions -----------------------------------------------------------
select results_eq(
  $$ select key from public.permissions order by key $$,
  $$ select unnest(array[
       'alerts.create', 'alerts.manage', 'alerts.view',
       'announcements.create', 'announcements.manage', 'announcements.view',
       'audit.view',
       'comments.create', 'comments.delete_own', 'comments.edit_own', 'comments.moderate',
       'community.update', 'community.view',
       'documents.manage', 'documents.upload', 'documents.view',
       'events.create', 'events.manage', 'events.view',
       'members.approve', 'members.invite', 'members.remove', 'members.suspend', 'members.view',
       'posts.create', 'posts.delete_own', 'posts.edit_own', 'posts.moderate', 'posts.view',
       'roles.manage', 'roles.view'
     ]) order by 1 $$,
  'exactly the 31 Stage 1 permissions are seeded'
);

select throws_ok(
  $$ insert into public.permissions (key, module, description) values ('community.view', 'community', 'dup') $$,
  '23505', null, 'duplicate permission keys are rejected'
);

-- Role templates -------------------------------------------------------------
select results_eq(
  $$ select t.key, count(tp.permission_id)::int
     from public.role_templates t
     left join public.role_template_permissions tp on tp.template_id = t.id
     group by t.key, t.sort_order order by t.sort_order $$,
  $$ values ('owner', 31), ('admin', 30), ('moderator', 17), ('member', 14) $$,
  'default role templates carry the documented number of permissions'
);

select is(
  (select key from public.role_templates where assign_to_creator),
  'owner', 'the Owner template is the one granted to community creators'
);

select is_empty(
  $$ select lower_t.key || ' not within ' || upper_t.key
     from (values ('member', 'moderator'), ('moderator', 'admin'), ('admin', 'owner')) as v(lo, hi)
     join public.role_templates lower_t on lower_t.key = v.lo
     join public.role_templates upper_t on upper_t.key = v.hi
     where exists (
       select permission_id from public.role_template_permissions where template_id = lower_t.id
       except
       select permission_id from public.role_template_permissions where template_id = upper_t.id
     ) $$,
  'templates nest: Member < Moderator < Admin < Owner'
);

select * from finish();
rollback;

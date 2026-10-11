-- Stage 1 / Migration 4: reference data
--
-- Permissions and default role templates are reference data that every
-- environment (including production) needs, so they live in a migration
-- rather than supabase/seed.sql (which only runs on local resets).
-- No users or communities are created here.

insert into public.permissions (key, module, description) values
  ('community.view',        'community',     'View the community and its basic information'),
  ('community.update',      'community',     'Edit community details and settings'),
  ('members.view',          'members',       'View community members'),
  ('members.invite',        'members',       'Invite people to join the community'),
  ('members.approve',       'members',       'Approve or reject membership requests'),
  ('members.suspend',       'members',       'Suspend and reinstate members'),
  ('members.remove',        'members',       'Remove members from the community'),
  ('roles.view',            'roles',         'View community roles'),
  ('roles.manage',          'roles',         'Create, edit and assign community roles'),
  ('posts.view',            'posts',         'View posts'),
  ('posts.create',          'posts',         'Create posts'),
  ('posts.edit_own',        'posts',         'Edit own posts'),
  ('posts.delete_own',      'posts',         'Delete own posts'),
  ('posts.moderate',        'posts',         'Moderate any post'),
  ('comments.create',       'comments',      'Create comments'),
  ('comments.edit_own',     'comments',      'Edit own comments'),
  ('comments.delete_own',   'comments',      'Delete own comments'),
  ('comments.moderate',     'comments',      'Moderate any comment'),
  ('announcements.view',    'announcements', 'View announcements'),
  ('announcements.create',  'announcements', 'Create announcements'),
  ('announcements.manage',  'announcements', 'Edit and delete any announcement'),
  ('alerts.view',           'alerts',        'View alerts'),
  ('alerts.create',         'alerts',        'Create alerts'),
  ('alerts.manage',         'alerts',        'Edit and delete any alert'),
  ('events.view',           'events',        'View events'),
  ('events.create',         'events',        'Create events'),
  ('events.manage',         'events',        'Edit and delete any event'),
  ('documents.view',        'documents',     'View documents'),
  ('documents.upload',      'documents',     'Upload documents'),
  ('documents.manage',      'documents',     'Edit and delete any document'),
  ('audit.view',            'audit',         'View the community audit log')
on conflict (key) do nothing;

insert into public.role_templates (key, name, description, assign_to_creator, sort_order) values
  ('owner',     'Owner',     'Full community administration, including roles and permissions.', true,  10),
  ('admin',     'Admin',     'Broad administration of members and content. Cannot manage roles.', false, 20),
  ('moderator', 'Moderator', 'Moderates posts, comments and member behaviour.',                  false, 30),
  ('member',    'Member',    'Standard community participation.',                                 false, 40)
on conflict (key) do nothing;

-- Member: normal participation.
-- Moderator: Member + moderation.
-- Admin: everything except roles.manage.
-- Owner: everything.
-- Each tier is a strict superset of the one below it. The anti-escalation
-- rules (see authorization migration) rely on permission-set comparison, so
-- this nesting is what lets e.g. a Moderator act on Members but not Admins.
with grants (template_key, permission_key) as (
  select 'member', k from unnest(array[
    'community.view', 'members.view', 'roles.view',
    'posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own',
    'comments.create', 'comments.edit_own', 'comments.delete_own',
    'announcements.view', 'alerts.view', 'events.view', 'documents.view'
  ]) as k
  union all
  select 'moderator', k from unnest(array[
    'community.view', 'members.view', 'roles.view',
    'posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own',
    'comments.create', 'comments.edit_own', 'comments.delete_own',
    'announcements.view', 'alerts.view', 'events.view', 'documents.view',
    'members.suspend', 'posts.moderate', 'comments.moderate'
  ]) as k
  union all
  select 'admin', p.key from public.permissions p where p.key <> 'roles.manage'
  union all
  select 'owner', p.key from public.permissions p
)
insert into public.role_template_permissions (template_id, permission_id)
select t.id, p.id
from grants g
join public.role_templates t on t.key = g.template_key
join public.permissions p on p.key = g.permission_key
on conflict do nothing;

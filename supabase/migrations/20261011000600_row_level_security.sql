-- Stage 1 / Migration 6: privileges and Row Level Security
--
-- Two layers:
--   1. Table/column GRANTs decide WHICH operations and columns a client role
--      may touch at all (e.g. clients can never write communities.status,
--      profiles.status or roles.is_system_role).
--   2. RLS policies decide WHICH ROWS, always via has_community_permission()
--      or the private helpers, never via role names.
--
-- Supabase's default privileges grant ALL on new public tables to anon,
-- authenticated and service_role, so everything is revoked first.
-- anon gets nothing in Stage 1. service_role bypasses RLS (server-side only,
-- never shipped to clients).

-- ---------------------------------------------------------------------------
-- Reset privileges
-- ---------------------------------------------------------------------------
revoke all on table
  public.profiles, public.communities, public.memberships, public.permissions,
  public.roles, public.membership_roles, public.role_permissions,
  public.role_templates, public.role_template_permissions
from public, anon, authenticated;

grant all on table
  public.profiles, public.communities, public.memberships, public.permissions,
  public.roles, public.membership_roles, public.role_permissions,
  public.role_templates, public.role_template_permissions
to service_role;

alter table public.profiles                  enable row level security;
alter table public.communities               enable row level security;
alter table public.memberships               enable row level security;
alter table public.permissions               enable row level security;
alter table public.roles                     enable row level security;
alter table public.membership_roles          enable row level security;
alter table public.role_permissions          enable row level security;
alter table public.role_templates            enable row level security;
alter table public.role_template_permissions enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Inserted by the auth trigger, removed by account deletion (cascade).
grant select on public.profiles to authenticated;
grant update (first_name, last_name, display_name, avatar_url, phone, bio)
  on public.profiles to authenticated;

create policy profiles_select_self_or_community on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.can_view_profile(id));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- communities
-- ---------------------------------------------------------------------------
-- No INSERT grant: communities are created only via public.create_community().
-- No DELETE grant: communities are archived by the platform, not deleted.
grant select on public.communities to authenticated;
grant update (name, description, community_type, logo_url, cover_image_url, timezone, settings)
  on public.communities to authenticated;

create policy communities_select_members on public.communities
  for select to authenticated
  using (public.has_community_permission(id, 'community.view'));

create policy communities_update_with_permission on public.communities
  for update to authenticated
  using (public.has_community_permission(id, 'community.update'))
  with check (public.has_community_permission(id, 'community.update'));

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------
-- No INSERT grant in Stage 1: memberships are created by create_community()
-- and, in Stage 2, by invitation / join-request flows. Allowing direct
-- inserts would let a community add arbitrary users without consent.
-- Status changes are further validated by private.enforce_membership_update().
grant select on public.memberships to authenticated;
grant update (status) on public.memberships to authenticated;
grant delete on public.memberships to authenticated;

create policy memberships_select_own_or_permitted on public.memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.has_community_permission(community_id, 'members.view')
  );

create policy memberships_update_own_or_permitted on public.memberships
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or public.has_community_permission(community_id, 'members.approve')
    or public.has_community_permission(community_id, 'members.suspend')
  )
  with check (
    user_id = (select auth.uid())
    or public.has_community_permission(community_id, 'members.approve')
    or public.has_community_permission(community_id, 'members.suspend')
  );

-- Removal of another member. Members leave by setting status = 'left'.
create policy memberships_delete_permitted on public.memberships
  for delete to authenticated
  using (
    user_id <> (select auth.uid())
    and public.has_community_permission(community_id, 'members.remove')
    and private.current_user_covers_membership(id)
  );

-- ---------------------------------------------------------------------------
-- permissions (global, non-sensitive catalog)
-- ---------------------------------------------------------------------------
grant select on public.permissions to authenticated;

create policy permissions_select_all on public.permissions
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- role templates (global, non-sensitive)
-- ---------------------------------------------------------------------------
grant select on public.role_templates, public.role_template_permissions to authenticated;

create policy role_templates_select_all on public.role_templates
  for select to authenticated
  using (true);

create policy role_template_permissions_select_all on public.role_template_permissions
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
-- Clients can create custom roles only (is_system_role is not grantable).
grant select on public.roles to authenticated;
grant insert (community_id, name, description) on public.roles to authenticated;
grant update (name, description) on public.roles to authenticated;
grant delete on public.roles to authenticated;

create policy roles_select_permitted on public.roles
  for select to authenticated
  using (public.has_community_permission(community_id, 'roles.view'));

create policy roles_insert_permitted on public.roles
  for insert to authenticated
  with check (
    not is_system_role
    and public.has_community_permission(community_id, 'roles.manage')
  );

create policy roles_update_permitted on public.roles
  for update to authenticated
  using (
    not is_system_role
    and public.has_community_permission(community_id, 'roles.manage')
  )
  with check (
    not is_system_role
    and public.has_community_permission(community_id, 'roles.manage')
  );

-- Assigned roles cannot be deleted (membership_roles FK is RESTRICT).
create policy roles_delete_permitted on public.roles
  for delete to authenticated
  using (
    not is_system_role
    and public.has_community_permission(community_id, 'roles.manage')
    and private.current_user_covers_role(id)
  );

-- ---------------------------------------------------------------------------
-- membership_roles
-- ---------------------------------------------------------------------------
-- community_id is filled by trigger from the membership; the composite FKs
-- guarantee the role belongs to the same community.
grant select on public.membership_roles to authenticated;
grant insert (membership_id, role_id) on public.membership_roles to authenticated;
grant delete on public.membership_roles to authenticated;

create policy membership_roles_select_own_or_permitted on public.membership_roles
  for select to authenticated
  using (
    private.is_own_membership(membership_id)
    or public.has_community_permission(community_id, 'members.view')
  );

-- Nobody can change their own role assignments, and nobody can grant a role
-- (or touch a member) carrying permissions they do not hold themselves.
create policy membership_roles_insert_permitted on public.membership_roles
  for insert to authenticated
  with check (
    public.has_community_permission(community_id, 'roles.manage')
    and not private.is_own_membership(membership_id)
    and private.current_user_covers_membership(membership_id)
    and private.current_user_covers_role(role_id)
  );

create policy membership_roles_delete_permitted on public.membership_roles
  for delete to authenticated
  using (
    public.has_community_permission(community_id, 'roles.manage')
    and not private.is_own_membership(membership_id)
    and private.current_user_covers_membership(membership_id)
    and private.current_user_covers_role(role_id)
  );

-- ---------------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------------
-- System role permissions are immutable from clients. Custom role
-- permissions can only include permissions the actor already holds.
grant select on public.role_permissions to authenticated;
grant insert (role_id, permission_id) on public.role_permissions to authenticated;
grant delete on public.role_permissions to authenticated;

create policy role_permissions_select_permitted on public.role_permissions
  for select to authenticated
  using (private.can_view_role(role_id));

create policy role_permissions_insert_permitted on public.role_permissions
  for insert to authenticated
  with check (private.can_manage_role_permission(role_id, permission_id));

create policy role_permissions_delete_permitted on public.role_permissions
  for delete to authenticated
  using (private.can_manage_role_permission(role_id, permission_id));

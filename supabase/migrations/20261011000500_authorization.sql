-- Stage 1 / Migration 5: authorization functions
--
-- Model: user -> membership (active) -> membership_roles -> roles
--        -> role_permissions -> permissions.key
--
-- WHY SECURITY DEFINER
--   RLS policies on memberships / membership_roles / role_permissions need
--   to ask "does the current user hold permission P in community C?". That
--   question itself reads memberships, membership_roles and role_permissions.
--   If the check ran as the caller, RLS on those tables would be applied
--   again inside the check, causing infinite recursion (or, worse, a check
--   that silently sees fewer rows than it should). Running the lookup as the
--   table owner bypasses RLS for the lookup only.
--
-- SAFETY RULES FOR EVERY DEFINER FUNCTION BELOW
--   * `set search_path = ''`, every object schema-qualified.
--   * The acting user is ALWAYS auth.uid() (from the verified JWT). No
--     function accepts a user id parameter, so callers cannot ask about, or
--     act as, someone else.
--   * Plain SQL, no dynamic SQL, no side effects (except create_community in
--     a later migration).
--   * Return only booleans about the caller, so they cannot be used to read
--     other tenants' data.
--   * EXECUTE revoked from PUBLIC/anon; granted to authenticated only.

-- ---------------------------------------------------------------------------
-- public.has_community_permission(community_id, permission_key)
-- ---------------------------------------------------------------------------
create or replace function public.has_community_permission(
  p_community_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.communities c       on c.id = m.community_id
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    join public.permissions p       on p.id = rp.permission_id
    where m.community_id = p_community_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and c.status = 'active'
      and p.key = p_permission_key
  );
$$;

comment on function public.has_community_permission(uuid, text) is
  'True when the CURRENT user (auth.uid()) holds the permission in the community via an active membership in an active community.';

-- ---------------------------------------------------------------------------
-- Internal helpers (private schema: not callable through the Data API)
-- ---------------------------------------------------------------------------

-- Permission ids the current user effectively holds in a community.
create or replace function private.current_user_permission_ids(p_community_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rp.permission_id
  from public.memberships m
  join public.communities c       on c.id = m.community_id
  join public.membership_roles mr on mr.membership_id = m.id
  join public.role_permissions rp on rp.role_id = mr.role_id
  where m.community_id = p_community_id
    and m.user_id = (select auth.uid())
    and m.status = 'active'
    and c.status = 'active';
$$;

-- Is this membership the current user's own?
create or replace function private.is_own_membership(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.id = p_membership_id
      and m.user_id = (select auth.uid())
  );
$$;

-- Anti-escalation: the current user may act on a target membership only if
-- every permission the target holds is also held by the current user in the
-- same community. A Moderator therefore cannot act on an Admin, and an Admin
-- (no roles.manage) cannot act on an Owner. Returns false if the current
-- user is not an active member of the target's community.
create or replace function private.current_user_covers_membership(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships t
    where t.id = p_membership_id
      and exists (
        select 1 from public.memberships a
        join public.communities c on c.id = a.community_id
        where a.community_id = t.community_id
          and a.user_id = (select auth.uid())
          and a.status = 'active'
          and c.status = 'active'
      )
      and not exists (
        select rp.permission_id
        from public.membership_roles mr
        join public.role_permissions rp on rp.role_id = mr.role_id
        where mr.membership_id = t.id
        except
        select private.current_user_permission_ids(t.community_id)
      )
  );
$$;

-- Anti-escalation: the current user may assign/unassign/delete a role only
-- if they themselves hold every permission the role grants.
create or replace function private.current_user_covers_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.roles r
    where r.id = p_role_id
      and exists (
        select 1 from public.memberships a
        join public.communities c on c.id = a.community_id
        where a.community_id = r.community_id
          and a.user_id = (select auth.uid())
          and a.status = 'active'
          and c.status = 'active'
      )
      and not exists (
        select rp.permission_id
        from public.role_permissions rp
        where rp.role_id = r.id
        except
        select private.current_user_permission_ids(r.community_id)
      )
  );
$$;

-- Can the current user add/remove this permission on this role?
--   * holds roles.manage in the role's community
--   * the role is not a system role
--   * holds the permission being granted/revoked (no granting what you lack)
create or replace function private.can_manage_role_permission(p_role_id uuid, p_permission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.roles r
    join public.permissions p on p.id = p_permission_id
    where r.id = p_role_id
      and not r.is_system_role
      and public.has_community_permission(r.community_id, 'roles.manage')
      and public.has_community_permission(r.community_id, p.key)
  );
$$;

-- Can the current user view the role's permission grants?
create or replace function private.can_view_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.roles r
    where r.id = p_role_id
      and public.has_community_permission(r.community_id, 'roles.view')
  );
$$;

-- Can the current user view another user's profile?
-- Yes when the target has a live membership (pending/active/suspended) in a
-- community where the current user holds members.view. Memberships can only
-- be created through consented flows (community creation now; invitations /
-- join requests in Stage 2), so a community cannot "capture" arbitrary users
-- to read their profiles.
create or replace function private.can_view_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships t
    where t.user_id = p_user_id
      and t.status in ('pending', 'active', 'suspended')
      and public.has_community_permission(t.community_id, 'members.view')
  );
$$;

-- True when this membership is active, grants roles.manage, and no other
-- active membership in the community grants roles.manage. Used to stop the
-- last role manager from leaving and orphaning the community.
create or replace function private.is_sole_role_manager(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with managers as (
    select distinct m.id, m.community_id
    from public.memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    join public.permissions p       on p.id = rp.permission_id
    where m.status = 'active'
      and p.key = 'roles.manage'
      and m.community_id = (select community_id from public.memberships where id = p_membership_id)
  )
  select exists (select 1 from managers where id = p_membership_id)
     and not exists (select 1 from managers where id <> p_membership_id);
$$;

-- ---------------------------------------------------------------------------
-- Membership status transitions
-- ---------------------------------------------------------------------------
-- RLS cannot compare OLD and NEW, so status transitions are validated here.
-- Enforced for client roles only; trusted server-side code (service_role,
-- migrations, SECURITY DEFINER functions) is not restricted by this trigger.
--
--   Self (target is the caller):
--     pending | active | suspended -> left      (leave / withdraw)
--   Others (caller must cover the target's permissions):
--     pending | rejected | left    -> active    requires members.approve
--     pending                      -> rejected  requires members.approve
--     active                       -> suspended requires members.suspend
--     suspended                    -> active    requires members.suspend
create or replace function private.enforce_membership_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.community_id is distinct from old.community_id
     or new.user_id is distinct from old.user_id then
    raise exception 'membership community_id and user_id are immutable'
      using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') or new.status = old.status then
    return new;
  end if;

  if old.user_id = (select auth.uid()) then
    if new.status = 'left' and old.status in ('pending', 'active', 'suspended') then
      if private.is_sole_role_manager(old.id) then
        raise exception 'the last member able to manage roles cannot leave the community'
          using errcode = '42501';
      end if;
      return new;
    end if;
    raise exception 'you cannot change your own membership status to %', new.status
      using errcode = '42501';
  end if;

  if not private.current_user_covers_membership(old.id) then
    raise exception 'insufficient privileges to modify this membership'
      using errcode = '42501';
  end if;

  if (old.status in ('pending', 'rejected', 'left') and new.status = 'active')
     or (old.status = 'pending' and new.status = 'rejected') then
    if public.has_community_permission(old.community_id, 'members.approve') then
      return new;
    end if;
  elsif (old.status = 'active' and new.status = 'suspended')
     or (old.status = 'suspended' and new.status = 'active') then
    if public.has_community_permission(old.community_id, 'members.suspend') then
      return new;
    end if;
  else
    raise exception 'invalid membership status transition: % -> %', old.status, new.status
      using errcode = '22023';
  end if;

  raise exception 'insufficient privileges for membership transition % -> %', old.status, new.status
    using errcode = '42501';
end;
$$;

create trigger memberships_enforce_update
  before update on public.memberships
  for each row execute function private.enforce_membership_update();

-- ---------------------------------------------------------------------------
-- Privileges on functions
-- ---------------------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon/authenticated by default;
-- revoke explicitly and re-grant only what is needed.
revoke all on function public.has_community_permission(uuid, text) from public, anon, authenticated;
revoke all on function private.current_user_permission_ids(uuid)         from public, anon, authenticated;
revoke all on function private.is_own_membership(uuid)                    from public, anon, authenticated;
revoke all on function private.current_user_covers_membership(uuid)       from public, anon, authenticated;
revoke all on function private.current_user_covers_role(uuid)             from public, anon, authenticated;
revoke all on function private.can_manage_role_permission(uuid, uuid)     from public, anon, authenticated;
revoke all on function private.can_view_role(uuid)                        from public, anon, authenticated;
revoke all on function private.can_view_profile(uuid)                     from public, anon, authenticated;
revoke all on function private.is_sole_role_manager(uuid)                 from public, anon, authenticated;
revoke all on function private.enforce_membership_update()                from public, anon, authenticated;

grant execute on function public.has_community_permission(uuid, text) to authenticated, service_role;
grant execute on function private.current_user_permission_ids(uuid)         to authenticated;
grant execute on function private.is_own_membership(uuid)                    to authenticated;
grant execute on function private.current_user_covers_membership(uuid)       to authenticated;
grant execute on function private.current_user_covers_role(uuid)             to authenticated;
grant execute on function private.can_manage_role_permission(uuid, uuid)     to authenticated;
grant execute on function private.can_view_role(uuid)                        to authenticated;
grant execute on function private.can_view_profile(uuid)                     to authenticated;
grant execute on function private.is_sole_role_manager(uuid)                 to authenticated;

-- Stage 3 / Migration 10: community and membership API
--
-- Stage 1 created the tables, permission model and RLS. This migration
-- completes the client-facing API for communities and memberships:
--
--   1. memberships.user_id -> profiles.id foreign key, so the Data API can
--      embed member profiles:  memberships?select=*,profiles(*)
--   2. Membership visibility by status: members.view shows ACTIVE members;
--      pending / suspended / rejected / left records are visible only to
--      members who manage membership (members.approve | suspend | remove).
--      Profile visibility follows the same rule.
--   3. public.my_communities(): the caller's memberships across ALL
--      communities in one call (community switcher), including pending and
--      suspended ones that RLS on communities would otherwise hide.
--   4. public.my_community_permissions(community_id): the caller's
--      effective permission keys in one community (UI gating only; the
--      database re-checks every operation).
--   5. Community creation limit (abuse protection) and a settings size cap.
--   6. Role lifecycle on membership transitions:
--        * admission (-> active) of a membership with no roles assigns the
--          community's default role for new members (Member by default);
--        * leaving or rejection (-> left | rejected) removes all role
--          assignments, so re-admission never silently restores old powers;
--        * suspension keeps roles (it is temporary; permissions are already
--          inert while the membership is not active).
--      The default role is identified by a flag, never by its name.
--
-- No authorization decision checks a role name: everything resolves to
-- permission keys via has_community_permission().

-- ---------------------------------------------------------------------------
-- 1. memberships -> profiles
-- ---------------------------------------------------------------------------
-- Every auth user has exactly one profile (Stage 2 invariant), so this
-- validates against existing rows. CASCADE matches memberships.user_id ->
-- auth.users: account deletion removes the profile and the memberships.
alter table public.memberships
  add constraint memberships_user_profile_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. Membership visibility by status
-- ---------------------------------------------------------------------------
create or replace function private.can_view_membership(p_community_id uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status = 'active' then
      public.has_community_permission(p_community_id, 'members.view')
    else
      public.has_community_permission(p_community_id, 'members.approve')
      or public.has_community_permission(p_community_id, 'members.suspend')
      or public.has_community_permission(p_community_id, 'members.remove')
  end;
$$;

comment on function private.can_view_membership(uuid, text) is
  'Active memberships need members.view; any other status needs a membership-management permission.';

create or replace function private.can_view_membership_id(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.id = p_membership_id
      and private.can_view_membership(m.community_id, m.status)
  );
$$;

revoke all on function private.can_view_membership(uuid, text) from public, anon, authenticated;
revoke all on function private.can_view_membership_id(uuid)    from public, anon, authenticated;
grant execute on function private.can_view_membership(uuid, text) to authenticated;
grant execute on function private.can_view_membership_id(uuid)    to authenticated;

alter policy memberships_select_own_or_permitted on public.memberships
  using (
    user_id = (select private.current_active_user_id())
    or private.can_view_membership(community_id, status)
  );

alter policy membership_roles_select_own_or_permitted on public.membership_roles
  using (
    private.is_own_membership(membership_id)
    or private.can_view_membership_id(membership_id)
  );

-- A profile is visible to co-members only through a membership they are
-- allowed to see (so plain members cannot see pending applicants' profiles).
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
      and private.can_view_membership(t.community_id, t.status)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. my_communities()
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because pending/suspended members cannot read the
-- communities table (community.view requires an active membership), yet
-- they need to see that their membership exists and its status. Returns
-- ONLY the caller's own memberships and only non-sensitive community
-- fields. Departed (left) and rejected memberships are omitted.
create or replace function public.my_communities()
returns table (
  community_id      uuid,
  name              text,
  slug              text,
  community_type    text,
  logo_url          text,
  community_status  text,
  membership_id     uuid,
  membership_status text,
  joined_at         timestamptz,
  role_names        text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.name, c.slug, c.community_type, c.logo_url, c.status,
    m.id, m.status, m.joined_at,
    array(
      select r.name
      from public.membership_roles mr
      join public.roles r on r.id = mr.role_id
      where mr.membership_id = m.id
      order by r.name
    )
  from public.memberships m
  join public.communities c on c.id = m.community_id
  where m.user_id = (select private.current_active_user_id())
    and m.status in ('pending', 'active', 'suspended')
  order by c.name, c.id;
$$;

comment on function public.my_communities() is
  'The calling user''s pending, active and suspended memberships across all communities. role_names are display labels only; never authorize on them.';

-- ---------------------------------------------------------------------------
-- 4. my_community_permissions()
-- ---------------------------------------------------------------------------
create or replace function public.my_community_permissions(p_community_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.key
  from public.permissions p
  where p.id in (select private.current_user_permission_ids(p_community_id))
  order by p.key;
$$;

comment on function public.my_community_permissions(uuid) is
  'The calling user''s effective permission keys in a community (empty unless an active member of an active community). For UI gating only.';

revoke all on function public.my_communities()                from public, anon, authenticated;
revoke all on function public.my_community_permissions(uuid)  from public, anon, authenticated;
grant execute on function public.my_communities()               to authenticated;
grant execute on function public.my_community_permissions(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Creation limit and settings size cap
-- ---------------------------------------------------------------------------
-- settings is client-writable (community.update); cap it so a community
-- cannot store arbitrarily large blobs. 16 KiB is generous for config.
alter table public.communities
  add constraint communities_settings_size check (pg_column_size(settings) <= 16384);

-- ---------------------------------------------------------------------------
-- 6. Default role for new members
-- ---------------------------------------------------------------------------
alter table public.role_templates
  add column assign_to_new_members boolean not null default false;
create unique index role_templates_single_new_member_template
  on public.role_templates (assign_to_new_members) where assign_to_new_members;
update public.role_templates set assign_to_new_members = true where key = 'member';

-- At most one default role per community. Not client-writable (no column
-- grant); set from the template at community creation.
alter table public.roles
  add column is_default_for_new_members boolean not null default false;
create unique index roles_single_default_per_community
  on public.roles (community_id) where is_default_for_new_members;

-- Backfill communities created before this migration: their copy of the
-- member template is the system role carrying exactly that template's name.
-- (One-off mapping at migration time; runtime code never matches on names.)
update public.roles r
set is_default_for_new_members = true
from public.role_templates t
where t.assign_to_new_members
  and r.is_system_role
  and r.name = t.name;

-- SECURITY DEFINER: the approver may lack roles.manage, yet admission must
-- grant the baseline role, and leaving must clear assignments the leaver
-- cannot delete themselves. Runs only on status transitions; it does not
-- read any caller-supplied value besides the membership row itself.
create or replace function private.apply_membership_role_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = old.status then
    return null;
  end if;

  if new.status in ('left', 'rejected') then
    delete from public.membership_roles where membership_id = new.id;
  elsif new.status = 'active'
        and not exists (select 1 from public.membership_roles where membership_id = new.id) then
    insert into public.membership_roles (membership_id, role_id)
    select new.id, r.id
    from public.roles r
    where r.community_id = new.community_id
      and r.is_default_for_new_members;
  end if;

  return null;
end;
$$;

revoke all on function private.apply_membership_role_lifecycle() from public, anon, authenticated;

create trigger memberships_role_lifecycle
  after update of status on public.memberships
  for each row execute function private.apply_membership_role_lifecycle();

-- create_community(): copies is_default_for_new_members from the templates
-- and adds a per-user limit of 10 new
-- communities per rolling 24 hours. The advisory lock serialises concurrent
-- calls from the same user so the count cannot be raced.
create or replace function public.create_community(
  p_name           text,
  p_slug           text,
  p_community_type text default 'other',
  p_description    text default null,
  p_timezone       text default 'UTC'
)
returns public.communities
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_daily_limit     constant integer := 10;
  v_user_id         uuid := private.current_active_user_id();
  v_community       public.communities;
  v_template        record;
  v_role_id         uuid;
  v_creator_role_id uuid;
  v_membership_id   uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_community:' || v_user_id::text, 0));

  if (select count(*) from public.communities
      where created_by = v_user_id and created_at > now() - interval '24 hours') >= c_daily_limit then
    raise exception 'community creation limit reached (% per 24 hours)', c_daily_limit
      using errcode = '53400';
  end if;

  insert into public.communities (name, slug, community_type, description, timezone, created_by)
  values (
    btrim(p_name),
    lower(btrim(p_slug)),
    coalesce(p_community_type, 'other'),
    p_description,
    coalesce(p_timezone, 'UTC'),
    v_user_id
  )
  returning * into v_community;

  for v_template in
    select t.id, t.name, t.description, t.assign_to_creator, t.assign_to_new_members
    from public.role_templates t
    order by t.sort_order, t.key
  loop
    insert into public.roles (community_id, name, description, is_system_role, is_default_for_new_members)
    values (v_community.id, v_template.name, v_template.description, true, v_template.assign_to_new_members)
    returning id into v_role_id;

    insert into public.role_permissions (role_id, permission_id)
    select v_role_id, tp.permission_id
    from public.role_template_permissions tp
    where tp.template_id = v_template.id;

    if v_template.assign_to_creator then
      v_creator_role_id := v_role_id;
    end if;
  end loop;

  if v_creator_role_id is null then
    raise exception 'no role template is configured for community creators';
  end if;

  insert into public.memberships (community_id, user_id, status)
  values (v_community.id, v_user_id, 'active')
  returning id into v_membership_id;

  insert into public.membership_roles (membership_id, role_id)
  values (v_membership_id, v_creator_role_id);

  return v_community;
end;
$$;

-- Supports the creation-limit count.
create index communities_created_by_created_at_idx on public.communities (created_by, created_at);

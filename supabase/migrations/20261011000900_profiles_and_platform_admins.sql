-- Stage 2 / Migration 9: profile behaviour and the platform-admin path
--
-- 1. platform_admins: the ONLY way to modify someone else's profile.
--    Profiles are global identities shared across every community a user
--    belongs to, so community permissions (even Owner) never grant the right
--    to edit them. Platform administration is a separate, platform-level
--    grant that can only be issued server-side (service_role / SQL).
-- 2. admin_set_account_status(): platform admins suspend / reactivate /
--    deactivate accounts. Combined with migration 8, a suspended user's
--    existing tokens stop working immediately.
-- 3. Profile normalisation: trimmed text, blank -> NULL, https-only avatars.
-- 4. Sign-up trigger hardened: only https avatar URLs are copied from
--    (user-controlled) sign-up metadata.

-- ---------------------------------------------------------------------------
-- platform_admins
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  -- Who granted it (audit trail); survives the granter's account deletion.
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Platform-level administrators. Managed only server-side (service_role or SQL); clients have no access.';

alter table public.platform_admins enable row level security;
revoke all on table public.platform_admins from public, anon, authenticated;
grant all on table public.platform_admins to service_role;
-- No policies: authenticated users can neither read nor write this table.

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.user_id = (select private.current_active_user_id())
  );
$$;

comment on function private.is_platform_admin() is
  'True when the caller (live session, active account) is a platform administrator.';

revoke all on function private.is_platform_admin() from public, anon, authenticated;
grant execute on function private.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- profiles: policies
-- ---------------------------------------------------------------------------
-- Read: own profile (any account status, live session required), platform
-- admins, or co-members with members.view (Stage 1 rule).
alter policy profiles_select_self_or_community on public.profiles
  using (
    id = (select private.current_session_user_id())
    or (select private.is_platform_admin())
    or private.can_view_profile(id)
  );

-- Write: own profile with an active account, or a platform admin.
-- Column grants (Stage 1) still limit writable columns to names, avatar,
-- phone and bio; status changes go through admin_set_account_status().
alter policy profiles_update_self on public.profiles
  using (
    id = (select private.current_active_user_id())
    or (select private.is_platform_admin())
  )
  with check (
    id = (select private.current_active_user_id())
    or (select private.is_platform_admin())
  );

alter policy profiles_update_self on public.profiles rename to profiles_update_self_or_platform_admin;
alter policy profiles_select_self_or_community on public.profiles rename to profiles_select_self_admin_or_community;

-- ---------------------------------------------------------------------------
-- admin_set_account_status()
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because clients hold no UPDATE privilege on
-- profiles.status. The caller must be a platform admin (checked from the
-- validated session), may not change their own status (prevents an admin
-- locking themselves out or un-suspending themselves), and may only set one
-- of the allowed values.
create or replace function public.admin_set_account_status(p_user_id uuid, p_status text)
returns public.profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if not private.is_platform_admin() then
    raise exception 'platform administrator privileges required' using errcode = '42501';
  end if;

  if p_user_id = private.current_active_user_id() then
    raise exception 'administrators cannot change their own account status' using errcode = '42501';
  end if;

  if p_status is null or p_status not in ('active', 'suspended', 'deactivated') then
    raise exception 'invalid account status: %', p_status using errcode = '22023';
  end if;

  update public.profiles set status = p_status
  where id = p_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;

comment on function public.admin_set_account_status(uuid, text) is
  'Platform admins only: set another user''s account status (active | suspended | deactivated).';

revoke all on function public.admin_set_account_status(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_account_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Profile normalisation
-- ---------------------------------------------------------------------------
create or replace function private.normalize_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.first_name   := nullif(btrim(new.first_name), '');
  new.last_name    := nullif(btrim(new.last_name), '');
  new.display_name := nullif(btrim(new.display_name), '');
  new.avatar_url   := nullif(btrim(new.avatar_url), '');
  new.phone        := nullif(btrim(new.phone), '');
  new.bio          := nullif(btrim(new.bio), '');
  return new;
end;
$$;

revoke all on function private.normalize_profile() from public;

create trigger profiles_normalize
  before insert or update on public.profiles
  for each row execute function private.normalize_profile();

-- Avatars are rendered by clients; only allow https URLs (blocks
-- javascript:, data:, http: and similar). NOT VALID: enforced for every new
-- write without rewriting or rejecting rows written before this migration.
alter table public.profiles
  add constraint profiles_avatar_url_https check (avatar_url ~* '^https://') not valid;

-- ---------------------------------------------------------------------------
-- Sign-up trigger: only copy https avatar URLs from metadata
-- ---------------------------------------------------------------------------
-- raw_user_meta_data is user-controlled (supplied at sign-up and editable by
-- the user later via auth.updateUser). It is used only to pre-fill the
-- profile, never for authorization. Values that would violate a profile
-- constraint are dropped or truncated so sign-up can never fail here.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta   jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  avatar text  := nullif(btrim(meta ->> 'avatar_url'), '');
begin
  insert into public.profiles (id, first_name, last_name, display_name, avatar_url)
  values (
    new.id,
    left(nullif(btrim(meta ->> 'first_name'), ''), 100),
    left(nullif(btrim(meta ->> 'last_name'), ''), 100),
    left(nullif(btrim(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name')), ''), 100),
    case when avatar ~* '^https://' and char_length(avatar) <= 2048 then avatar end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

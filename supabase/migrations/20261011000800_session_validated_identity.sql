-- Stage 2 / Migration 8: server-validated identity
--
-- PROBLEM
--   auth.uid() only proves that the request carries a correctly signed,
--   unexpired JWT. Supabase access tokens are stateless: after a user signs
--   out (or an operator revokes their sessions), the old access token keeps
--   working until it expires (jwt_expiry, 1 hour). Platform-level account
--   status (profiles.status) was also not enforced anywhere.
--
-- SOLUTION
--   Two helpers become the only source of "who is calling":
--
--   private.current_session_user_id()
--     auth.uid(), but only if the JWT's session_id refers to a session that
--     still exists in auth.sessions for that same user, has not passed its
--     not_after, the token is an `authenticated` token, and the user is not
--     anonymous. Signing out deletes the session row, so a signed-out
--     token stops working immediately, even though its signature is valid.
--
--   private.current_active_user_id()
--     current_session_user_id(), but only if profiles.status = 'active'.
--     Suspended / deactivated accounts lose all access immediately.
--
--   Every Stage 1 function and policy that used auth.uid() is redefined
--   below to use current_active_user_id(). The only exception: a user with
--   a valid session may still read their OWN profile while suspended, so a
--   client can show "your account is suspended" instead of a blank screen.
--
-- WHY SECURITY DEFINER: clients have no access to auth.sessions (owned by
-- Supabase Auth). The helpers read one row by primary key, take no
-- parameters, pin search_path and return only the caller's own id.

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------
create or replace function private.current_session_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id
  from auth.sessions s
  where s.id = (
      select case
        when claims ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'session_id')::uuid
      end
      from (select auth.jwt() as claims) j
      where claims ->> 'role' = 'authenticated'
        and coalesce(claims ->> 'is_anonymous', 'false') = 'false'
    )
    and s.user_id = auth.uid()
    and (s.not_after is null or s.not_after > now());
$$;

comment on function private.current_session_user_id() is
  'auth.uid() if, and only if, the JWT belongs to a live, non-anonymous session. NULL otherwise.';

create or replace function private.current_active_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.id = (select private.current_session_user_id())
    and p.status = 'active';
$$;

comment on function private.current_active_user_id() is
  'The calling user if they have a live session AND an active account. NULL otherwise. Use this for all authorization.';

revoke all on function private.current_session_user_id() from public, anon, authenticated;
revoke all on function private.current_active_user_id()  from public, anon, authenticated;
grant execute on function private.current_session_user_id() to authenticated;
grant execute on function private.current_active_user_id()  to authenticated;

-- ---------------------------------------------------------------------------
-- Redefine Stage 1 authorization functions on top of the validated identity
-- (bodies unchanged except auth.uid() -> private.current_active_user_id()).
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
      and m.user_id = (select private.current_active_user_id())
      and m.status = 'active'
      and c.status = 'active'
      and p.key = p_permission_key
  );
$$;

comment on function public.has_community_permission(uuid, text) is
  'True when the CURRENT user (live session, active account) holds the permission in the community via an active membership in an active community.';

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
    and m.user_id = (select private.current_active_user_id())
    and m.status = 'active'
    and c.status = 'active';
$$;

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
      and m.user_id = (select private.current_active_user_id())
  );
$$;

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
          and a.user_id = (select private.current_active_user_id())
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
          and a.user_id = (select private.current_active_user_id())
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

  if old.user_id = (select private.current_active_user_id()) then
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
    select t.id, t.name, t.description, t.assign_to_creator
    from public.role_templates t
    order by t.sort_order, t.key
  loop
    insert into public.roles (community_id, name, description, is_system_role)
    values (v_community.id, v_template.name, v_template.description, true)
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

-- ---------------------------------------------------------------------------
-- Redefine Stage 1 policies that referenced auth.uid() directly
-- ---------------------------------------------------------------------------
alter policy memberships_select_own_or_permitted on public.memberships
  using (
    user_id = (select private.current_active_user_id())
    or public.has_community_permission(community_id, 'members.view')
  );

alter policy memberships_update_own_or_permitted on public.memberships
  using (
    user_id = (select private.current_active_user_id())
    or public.has_community_permission(community_id, 'members.approve')
    or public.has_community_permission(community_id, 'members.suspend')
  )
  with check (
    user_id = (select private.current_active_user_id())
    or public.has_community_permission(community_id, 'members.approve')
    or public.has_community_permission(community_id, 'members.suspend')
  );

alter policy memberships_delete_permitted on public.memberships
  using (
    user_id <> (select private.current_active_user_id())
    and public.has_community_permission(community_id, 'members.remove')
    and private.current_user_covers_membership(id)
  );

-- profiles policies are redefined in the next migration together with the
-- platform-admin path.

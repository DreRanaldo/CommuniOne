-- RN-14 / Migration 28: the community member directory.
--
-- Two read-only functions give the app exactly the fields a member directory
-- may show, for ONE community the caller belongs to:
--
--   list_community_members(community, query?, page)   active members, by name
--   get_community_member(community, user)              one member's community profile
--
-- Privacy (enforced here, not in the app):
--   * the caller needs members.view in THAT community (an active membership);
--   * only ACTIVE members of that community, with an active account, are
--     returned: pending, suspended, rejected and departed people, and members
--     of other communities, are not (not even through search);
--   * the fields returned are the community profile only: display name,
--     first / last name, avatar, bio, roles (only with roles.view), join date.
--     Phone numbers live in profile_private (owner-only RLS, migration 19)
--     and are never read here; e-mail lives in auth.users and is never
--     exposed; account status and timestamps are not returned;
--   * search matches names only (never e-mail or phone), inside the given
--     community; LIKE wildcards in the query are matched literally.
--
-- SECURITY DEFINER with explicit checks (the profile RLS rule is broader: any
-- community the two people share). No table, policy or privilege changes.

-- The name a member is shown under (display name, else first + last).
create or replace function private.member_display_name(p_display text, p_first text, p_last text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(btrim(p_display), ''), nullif(btrim(concat_ws(' ', btrim(p_first), btrim(p_last))), ''));
$$;

revoke all on function private.member_display_name(text, text, text) from public, anon, authenticated;

create or replace function public.list_community_members(
  p_community_id   uuid,
  p_query          text    default null,
  p_limit          integer default 30,
  p_cursor_unnamed boolean default null,
  p_cursor_name    text    default null,
  p_cursor_id      uuid    default null
)
returns table (
  membership_id uuid,
  user_id       uuid,
  display_name  text,
  avatar_path   text,
  avatar_url    text,
  role_names    text[],
  joined_at     timestamptz,
  is_me         boolean,
  sort_unnamed  boolean,
  sort_name     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.current_active_user_id();
  v_query   text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_roles   boolean;
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.has_community_permission(p_community_id, 'members.view') then
    raise exception 'members.view is required in this community' using errcode = '42501';
  end if;
  if v_query is not null and char_length(v_query) > 100 then
    raise exception 'search text can be at most 100 characters' using errcode = '22023';
  end if;
  if (p_cursor_id is null) <> (p_cursor_unnamed is null) or (p_cursor_id is not null and p_cursor_name is null) then
    raise exception 'cursor requires p_cursor_unnamed, p_cursor_name and p_cursor_id' using errcode = '22023';
  end if;
  v_roles := public.has_community_permission(p_community_id, 'roles.view');
  -- Wildcards typed by the user are literal characters.
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with people as (
    select m.id as membership_id, m.user_id, m.joined_at,
           private.member_display_name(pr.display_name, pr.first_name, pr.last_name) as name,
           pr.display_name, pr.first_name, pr.last_name, pr.avatar_path, pr.avatar_url
    from public.memberships m
    join public.profiles pr on pr.id = m.user_id
    where m.community_id = p_community_id
      and m.status = 'active'
      and pr.status = 'active'
  )
  select p.membership_id, p.user_id, p.name, p.avatar_path, p.avatar_url,
         case when v_roles then coalesce((
           select array_agg(r.name order by r.name)
           from public.membership_roles mr
           join public.roles r on r.id = mr.role_id
           where mr.membership_id = p.membership_id
         ), array[]::text[]) end,
         p.joined_at,
         p.user_id = v_me,
         p.name is null,
         lower(coalesce(p.name, ''))
  from people p
  where (v_query is null
         or p.name ilike v_pattern
         or p.first_name ilike v_pattern
         or p.last_name ilike v_pattern)
    and (p_cursor_id is null
         or ((p.name is null), lower(coalesce(p.name, '')), p.user_id)
            > (p_cursor_unnamed, p_cursor_name, p_cursor_id))
  order by (p.name is null), lower(coalesce(p.name, '')), p.user_id
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

create or replace function public.get_community_member(p_community_id uuid, p_user_id uuid)
returns table (
  membership_id uuid,
  user_id       uuid,
  display_name  text,
  first_name    text,
  last_name     text,
  bio           text,
  avatar_path   text,
  avatar_url    text,
  role_names    text[],
  joined_at     timestamptz,
  is_me         boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_active_user_id();
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.has_community_permission(p_community_id, 'members.view') then
    raise exception 'members.view is required in this community' using errcode = '42501';
  end if;
  return query
  select m.id, m.user_id,
         private.member_display_name(pr.display_name, pr.first_name, pr.last_name),
         nullif(btrim(pr.first_name), ''), nullif(btrim(pr.last_name), ''), nullif(btrim(pr.bio), ''),
         pr.avatar_path, pr.avatar_url,
         case when public.has_community_permission(p_community_id, 'roles.view') then coalesce((
           select array_agg(r.name order by r.name)
           from public.membership_roles mr
           join public.roles r on r.id = mr.role_id
           where mr.membership_id = m.id
         ), array[]::text[]) end,
         m.joined_at,
         m.user_id = v_me
  from public.memberships m
  join public.profiles pr on pr.id = m.user_id
  where m.community_id = p_community_id
    and m.user_id = p_user_id
    and m.status = 'active'
    and pr.status = 'active';
end;
$$;

revoke all on function public.list_community_members(uuid, text, integer, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.get_community_member(uuid, uuid)                                from public, anon, authenticated;
grant execute on function public.list_community_members(uuid, text, integer, boolean, text, uuid) to authenticated;
grant execute on function public.get_community_member(uuid, uuid)                                to authenticated;

comment on function public.list_community_members(uuid, text, integer, boolean, text, uuid) is
  'RN-14 member directory: active members of one community (members.view), community-profile fields only, name search, keyset by name.';
comment on function public.get_community_member(uuid, uuid) is
  'RN-14 member profile: one active member of one community (members.view), community-profile fields only.';

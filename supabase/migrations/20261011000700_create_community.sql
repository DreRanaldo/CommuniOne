-- Stage 1 / Migration 7: atomic community creation
--
-- public.create_community() is the ONLY client path for creating a
-- community. In one transaction it:
--   1. creates the community (created_by = auth.uid())
--   2. copies every role template into community-scoped system roles,
--      including their permissions
--   3. creates an active membership for the caller
--   4. assigns the caller the template flagged assign_to_creator (Owner)
--
-- WHY SECURITY DEFINER: clients have no INSERT privilege on communities,
-- memberships, roles, membership_roles or role_permissions (and must not, or
-- they could create memberships / grants freely). This function performs
-- those inserts on their behalf with a fixed, auditable recipe.
-- The creator is always auth.uid(); no parameter can change who becomes the
-- owner. search_path is pinned and all objects are schema-qualified.

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
  v_user_id         uuid := auth.uid();
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

comment on function public.create_community(text, text, text, text, text) is
  'Atomically creates a community, its default roles, and an active Owner membership for the caller.';

revoke all on function public.create_community(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_community(text, text, text, text, text) to authenticated;

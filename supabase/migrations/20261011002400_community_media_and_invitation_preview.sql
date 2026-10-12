-- RN-05 / Migration 24: community logo and cover image uploads, and a
-- read-only invitation preview for the mobile create / join workflows.
--
-- 1. Community media (logo, cover image)
--    Decision: a PUBLIC bucket, `community-media`. A community's logo and
--    cover are branding, not personal data, and they must be visible to people
--    who are not members yet: someone previewing an invitation sees the logo
--    before joining, and cannot be given a signed URL (signing requires read
--    access). Paths are {community_id}/{random uuid}.{ext}, so files cannot be
--    guessed or listed (no listing is allowed to non-members); only people
--    given a path by the API can load them.
--      * upload / delete: holders of community.update in that community only;
--      * no overwrite or move (no UPDATE policy); a new image is a new file;
--      * communities.logo_path / cover_image_path point at the current files;
--        the database checks they are in that community's folder and exist;
--      * replaced files are removed by the app, leftovers by a service-role
--        purge job (list_community_media_to_purge).
--    logo_url / cover_image_url remain for external https images; *_path
--    takes precedence when both are set.
--
-- 2. my_communities() also returns logo_path (the switcher shows logos).
--
-- 3. preview_invitation(token): what an invitation would join, WITHOUT
--    joining. It applies exactly the checks redeem_invitation() applies (same
--    errors, same order), consumes nothing, and adds the caller's existing
--    membership status so the app can say "you are already a member" before
--    anything happens. Unknown tokens get the same "invalid invitation" error,
--    so a preview reveals nothing to someone without a valid token.

-- ---------------------------------------------------------------------------
-- 1. Community media
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-media', 'community-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

alter table public.communities
  add column logo_path text
    constraint communities_logo_path_format check (
      logo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    ),
  add column cover_image_path text
    constraint communities_cover_image_path_format check (
      cover_image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    );

comment on column public.communities.logo_path is
  'Current logo in the public community-media bucket ({community_id}/{uuid}.{ext}).';
comment on column public.communities.cover_image_path is
  'Current cover image in the public community-media bucket ({community_id}/{uuid}.{ext}).';

-- Same rule as the other editable columns: RLS requires community.update.
grant update (logo_path, cover_image_path) on public.communities to authenticated;

-- Community that owns a media object, from its folder; NULL for anything malformed.
create or replace function private.community_media_owner(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

-- Upload: community.update in the folder's community.
create or replace function private.can_manage_community_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.community_media_owner(p_name) is not null
     and public.has_community_permission(private.community_media_owner(p_name), 'community.update');
$$;

-- Delete: as upload, except the files the community currently uses.
create or replace function private.can_delete_community_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_manage_community_media(p_name)
     and not exists (
       select 1 from public.communities c
       where c.logo_path = p_name or c.cover_image_path = p_name
     );
$$;

-- API reads (list, delete lookups): members of the community. Public URLs are
-- served by Storage without these policies.
create or replace function private.can_read_community_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.community_media_owner(p_name) is not null
     and public.has_community_permission(private.community_media_owner(p_name), 'community.view');
$$;

revoke all on function private.community_media_owner(text)        from public, anon, authenticated;
revoke all on function private.can_manage_community_media(text)   from public, anon, authenticated;
revoke all on function private.can_delete_community_media(text)   from public, anon, authenticated;
revoke all on function private.can_read_community_media(text)     from public, anon, authenticated;
grant execute on function private.can_manage_community_media(text) to authenticated;
grant execute on function private.can_delete_community_media(text) to authenticated;
grant execute on function private.can_read_community_media(text)   to authenticated;

-- communities.logo_path / cover_image_path must name an existing file in the
-- community's own folder.
create or replace function private.check_community_media()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  foreach v_path in array array[new.logo_path, new.cover_image_path] loop
    continue when v_path is null;
    continue when tg_op = 'UPDATE' and (v_path is not distinct from old.logo_path or v_path is not distinct from old.cover_image_path);
    if private.community_media_owner(v_path) is distinct from new.id then
      raise exception 'community images must be uploaded to that community''s folder' using errcode = '42501';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'community-media' and o.name = v_path) then
      raise exception 'image upload not found; upload the image first' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private.check_community_media() from public, anon, authenticated;

create trigger communities_check_media
  before insert or update of logo_path, cover_image_path on public.communities
  for each row execute function private.check_community_media();

drop policy if exists community_media_select on storage.objects;
drop policy if exists community_media_insert on storage.objects;
drop policy if exists community_media_delete on storage.objects;

create policy community_media_select on storage.objects
  for select to authenticated
  using (bucket_id = 'community-media' and private.can_read_community_media(name));

create policy community_media_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'community-media' and private.can_manage_community_media(name));

create policy community_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-media' and private.can_delete_community_media(name));

-- Purge listing (service role): media files no community uses any more.
create or replace function public.list_community_media_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'community-media'
    and o.created_at < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour')
    and not exists (
      select 1 from public.communities c
      where c.logo_path = o.name or c.cover_image_path = o.name
    )
  order by o.created_at
  limit 1000;
$$;

revoke all on function public.list_community_media_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_community_media_to_purge(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 2. my_communities() with logo_path (return type changes: drop and recreate)
-- ---------------------------------------------------------------------------
drop function public.my_communities();

create function public.my_communities()
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
  role_names        text[],
  logo_path         text
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
    ),
    c.logo_path
  from public.memberships m
  join public.communities c on c.id = m.community_id
  where m.user_id = (select private.current_active_user_id())
    and m.status in ('pending', 'active', 'suspended')
  order by c.name, c.id;
$$;

comment on function public.my_communities() is
  'The calling user''s pending, active and suspended memberships across all communities. role_names are display labels only; never authorize on them.';

revoke all on function public.my_communities() from public, anon;
grant execute on function public.my_communities() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. preview_invitation()
-- ---------------------------------------------------------------------------
create or replace function public.preview_invitation(p_token text)
returns table (
  community_id      uuid,
  name              text,
  community_type    text,
  description       text,
  logo_url          text,
  logo_path         text,
  cover_image_url   text,
  cover_image_path  text,
  member_count      integer,
  expires_at        timestamptz,
  membership_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.current_active_user_id();
  v_inv  public.invitations;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_inv from public.invitations i
  where i.token_hash = private.invitation_token_hash(p_token);

  -- The same checks, in the same order, with the same errors as redeem_invitation().
  if v_inv.id is null then
    raise exception 'invalid invitation' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'this invitation has been revoked' using errcode = '22023';
  end if;
  if v_inv.status = 'expired' or v_inv.expires_at <= now() then
    raise exception 'this invitation has expired' using errcode = '22023';
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    raise exception 'this invitation has reached its maximum number of uses' using errcode = '22023';
  end if;
  if v_inv.created_by is null or v_inv.created_by not in (
    select private.community_members_with_permission(v_inv.community_id, 'members.invite')
  ) then
    raise exception 'this invitation is no longer valid' using errcode = '22023';
  end if;

  return query
  select
    c.id, c.name, c.community_type, c.description,
    c.logo_url, c.logo_path, c.cover_image_url, c.cover_image_path,
    (select count(*)::integer from public.memberships m
      where m.community_id = c.id and m.status = 'active'),
    v_inv.expires_at,
    (select m.status from public.memberships m
      where m.community_id = c.id and m.user_id = v_user)
  from public.communities c
  where c.id = v_inv.community_id;
end;
$$;

comment on function public.preview_invitation(text) is
  'What an invitation would join, without joining: the same checks and errors as redeem_invitation(), plus the caller''s existing membership status. Consumes nothing.';

revoke all on function public.preview_invitation(text) from public, anon;
grant execute on function public.preview_invitation(text) to authenticated;

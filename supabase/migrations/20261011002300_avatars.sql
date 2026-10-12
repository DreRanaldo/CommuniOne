-- RN-03 / Migration 23: profile avatars (uploaded images)
--
-- Decision: a PRIVATE Storage bucket. Profiles are visible only to the user,
-- platform admins and co-members (Stage 1/3 rules), so an avatar image follows
-- exactly the same rule: the app shows it through short-lived signed URLs, and
-- a link copied out of the app stops working. A public bucket would let anyone
-- holding a URL see the photo forever, independent of membership.
--
-- Layout:  avatars/{user_id}/{random uuid}.{jpg|png|webp}
--   * only the owner (active account) can upload, and only into their folder;
--   * files are never overwritten (no UPDATE policy); a new avatar is a new file;
--   * profiles.avatar_path points at the current file; the database checks that
--     it is in the owner's folder and that the file exists;
--   * old and orphaned files (replaced avatars, deleted accounts) are removed by
--     the owner or by a service-role purge job (list_avatar_files_to_purge).
--
-- profiles.avatar_url stays for external https avatars (sign-up metadata);
-- avatar_path takes precedence when both are set.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

alter table public.profiles
  add column avatar_path text
  constraint profiles_avatar_path_format check (
    avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

comment on column public.profiles.avatar_path is
  'Current avatar file in the private avatars bucket ({user_id}/{uuid}.{ext}). Shown through signed URLs.';

-- The user (or a platform admin removing it) may set or clear avatar_path.
grant update (avatar_path) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Owner of an avatar object, from its folder; NULL for anything malformed.
create or replace function private.avatar_owner(p_name text)
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

-- Read an avatar file: exactly the people who may read the owner's profile.
create or replace function private.can_read_avatar_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.avatar_owner(p_name) is not null and (
    private.avatar_owner(p_name) = (select private.current_session_user_id())
    or (select private.is_platform_admin())
    or private.can_view_profile(private.avatar_owner(p_name))
  );
$$;

-- Upload: only into your own folder, with an active account.
create or replace function private.can_upload_avatar_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.avatar_owner(p_name) is not null
     and private.avatar_owner(p_name) = (select private.current_active_user_id());
$$;

-- Delete: your own files, except the one your profile currently uses (clear
-- avatar_path first), so a profile never points at a missing file.
create or replace function private.can_delete_avatar_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_upload_avatar_object(p_name)
     and not exists (select 1 from public.profiles p where p.avatar_path = p_name);
$$;

revoke all on function private.avatar_owner(text)            from public, anon, authenticated;
revoke all on function private.can_read_avatar_object(text)   from public, anon, authenticated;
revoke all on function private.can_upload_avatar_object(text) from public, anon, authenticated;
revoke all on function private.can_delete_avatar_object(text) from public, anon, authenticated;
grant execute on function private.can_read_avatar_object(text)   to authenticated;
grant execute on function private.can_upload_avatar_object(text) to authenticated;
grant execute on function private.can_delete_avatar_object(text) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles.avatar_path must name an existing file in the owner's own folder
-- ---------------------------------------------------------------------------
create or replace function private.check_profile_avatar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.avatar_path is null or (tg_op = 'UPDATE' and new.avatar_path is not distinct from old.avatar_path) then
    return new;
  end if;
  if private.avatar_owner(new.avatar_path) is distinct from new.id then
    raise exception 'an avatar must be an image uploaded to your own folder' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = new.avatar_path) then
    raise exception 'avatar upload not found; upload the image first' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_profile_avatar() from public, anon, authenticated;

create trigger profiles_check_avatar
  before insert or update of avatar_path on public.profiles
  for each row execute function private.check_profile_avatar();

-- ---------------------------------------------------------------------------
-- Storage policies (avatars bucket). No UPDATE policy: no overwrite or move.
-- ---------------------------------------------------------------------------
drop policy if exists avatars_objects_select on storage.objects;
drop policy if exists avatars_objects_insert on storage.objects;
drop policy if exists avatars_objects_delete on storage.objects;

create policy avatars_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and private.can_read_avatar_object(name));

create policy avatars_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and private.can_upload_avatar_object(name));

create policy avatars_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and private.can_delete_avatar_object(name));

-- ---------------------------------------------------------------------------
-- Purge listing (service role): avatar files no profile uses any more:
-- replaced avatars and the avatars of deleted accounts (personal data).
-- The job deletes them through the Storage API.
-- ---------------------------------------------------------------------------
create or replace function public.list_avatar_files_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'avatars'
    and o.created_at < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour')
    and not exists (select 1 from public.profiles p where p.avatar_path = o.name)
  order by o.created_at
  limit 1000;
$$;

revoke all on function public.list_avatar_files_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_avatar_files_to_purge(interval) to service_role;

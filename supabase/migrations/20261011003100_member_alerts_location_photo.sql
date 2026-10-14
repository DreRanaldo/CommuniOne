-- Migration 31: members send alerts, with an optional location and photo
--
-- 1. Members (and Moderators) may issue alerts: alerts.create is added to
--    the Member and Moderator templates and to every community's existing
--    Member and Moderator system roles. Unchanged and still enforced:
--      * emergency severity needs alerts.manage (Owners, Admins);
--      * taking a published alert down needs alerts.manage (migration 30);
--      * at most 20 alerts per user per hour (rate limit, migration 21).
--    Communities that do not want this can remove alerts.create from these
--    roles (Admin Web / SQL); nothing here checks a role name at run time.
--
-- 2. Location: an alert may carry the sender's position when they choose to
--    share it (latitude / longitude in WGS84 degrees, accuracy in metres).
--    It is set only when the alert is created (no UPDATE grant), visible to
--    exactly those who can see the alert (the alerts RLS), and never
--    collected otherwise: the app reads the position only after the sender
--    asks it to.
--
-- 3. Photo: one picture per alert in a PRIVATE bucket, `alert-images`,
--    shown through short-lived signed URLs:
--      alert-images/{community_id}/{user_id}/{uuid}.{jpg|png|webp}
--    * upload: your own folder of a community where you hold alerts.create;
--    * no overwrite (no UPDATE policy);
--    * read: anyone who can see an alert using the file, and the uploader;
--    * delete: the uploader, only while no alert uses the file (cleanup
--      after a failed send).
--    alerts.image_path is set only at creation, must be the creator's own
--    file in the alert's community, and must exist.

-- ---------------------------------------------------------------------------
-- 1. alerts.create for Members and Moderators
-- ---------------------------------------------------------------------------
insert into public.role_template_permissions (template_id, permission_id)
select t.id, p.id
from public.role_templates t
cross join public.permissions p
where t.key in ('member', 'moderator') and p.key = 'alerts.create'
on conflict do nothing;

-- Existing communities: their system roles were copied from these templates
-- at creation (same name, is_system_role). One-off data migration.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.role_templates t on t.name = r.name and t.key in ('member', 'moderator')
cross join public.permissions p
where r.is_system_role and p.key = 'alerts.create'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Location and 3. photo columns
-- ---------------------------------------------------------------------------
alter table public.alerts
  add column latitude           double precision check (latitude between -90 and 90),
  add column longitude          double precision check (longitude between -180 and 180),
  add column location_accuracy_m real check (location_accuracy_m between 0 and 100000),
  add column image_path         text check (image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  add constraint alerts_location_complete check (
    (latitude is null) = (longitude is null)
    and (location_accuracy_m is null or latitude is not null)
  );

create unique index alerts_image_path_key on public.alerts (image_path) where image_path is not null;

comment on column public.alerts.latitude is
  'Where the sender was, if they chose to share it when sending (WGS84). Visible to whoever can see the alert.';
comment on column public.alerts.image_path is
  'Optional photo in the private alert-images bucket, set only when the alert is created.';

-- Insert only: location and photo cannot be added or changed later.
grant insert (latitude, longitude, location_accuracy_m, image_path) on public.alerts to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('alert-images', 'alert-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Helpers (same folder layout as post-images)
-- ---------------------------------------------------------------------------
create or replace function private.can_upload_alert_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select f.user_id is not null
     and f.user_id = (select private.current_active_user_id())
     and public.has_community_permission(f.community_id, 'alerts.create')
  from private.post_image_folder(p_name) f;
$$;

create or replace function private.can_read_alert_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.alerts a
      where a.image_path = p_name
        and private.can_view_alert_row(a.community_id, a.created_by, a.status)
    )
    or (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
        from private.post_image_folder(p_name) f);
$$;

create or replace function private.can_delete_alert_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
          from private.post_image_folder(p_name) f)
     and not exists (select 1 from public.alerts a where a.image_path = p_name);
$$;

revoke all on function private.can_upload_alert_image_object(text) from public, anon, authenticated;
revoke all on function private.can_read_alert_image_object(text)   from public, anon, authenticated;
revoke all on function private.can_delete_alert_image_object(text) from public, anon, authenticated;
grant execute on function private.can_upload_alert_image_object(text) to authenticated;
grant execute on function private.can_read_alert_image_object(text)   to authenticated;
grant execute on function private.can_delete_alert_image_object(text) to authenticated;

-- The photo must be the creator's own uploaded file in the alert's
-- community. SECURITY DEFINER to look at storage.objects.
create or replace function private.check_alert_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder record;
begin
  if new.image_path is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.image_path is not distinct from old.image_path then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'an alert''s photo cannot be changed' using errcode = '42501';
  end if;
  select * into v_folder from private.post_image_folder(new.image_path);
  if v_folder.community_id is distinct from new.community_id
     or v_folder.user_id is distinct from new.created_by then
    raise exception 'the photo must be your own upload for this community' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'alert-images' and o.name = new.image_path) then
    raise exception 'the photo was not uploaded' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_alert_image() from public, anon, authenticated;

create trigger alerts_check_image
  before insert or update of image_path on public.alerts
  for each row execute function private.check_alert_image();

-- ---------------------------------------------------------------------------
-- Storage policies (alert-images bucket). No UPDATE policy: no overwrite.
-- ---------------------------------------------------------------------------
create policy alert_images_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'alert-images' and private.can_read_alert_image_object(name));

create policy alert_images_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'alert-images' and private.can_upload_alert_image_object(name));

create policy alert_images_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'alert-images' and private.can_delete_alert_image_object(name));

-- Files left behind by a failed send (no alert uses them), for a scheduled
-- cleanup job (service role), like list_post_image_files_to_purge.
create or replace function public.list_alert_image_files_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'alert-images'
    and o.created_at < now() - p_grace
    and not exists (select 1 from public.alerts a where a.image_path = o.name)
  order by o.created_at
  limit 1000;
$$;

revoke all on function public.list_alert_image_files_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_alert_image_files_to_purge(interval) to service_role;

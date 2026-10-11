-- Stage 10 / Migration 16: documents and file storage
--
-- Files live in Supabase Storage (bucket 'documents', PRIVATE). PostgreSQL
-- stores only metadata. Two independent layers enforce access:
--   1. RLS on public.documents / public.document_folders (metadata)
--   2. RLS policies on storage.objects (the files themselves)
-- The storage policies do NOT rely on the metadata RLS; they re-check the
-- same rules through SECURITY DEFINER helpers.
--
-- Nothing the client sends is trusted:
--   * storage path   generated column: communities/{community_id}/documents/{id}/file.{ext}
--   * file name      used for display only; sanitised; never part of the path
--   * MIME type      must be on the allow-list; the extension comes from the
--                    allow-list, not from the file name; re-checked against
--                    what Storage actually recorded
--   * file size      limited by a configurable setting (and the bucket
--                    ceiling); the stored size is what Storage recorded
--   * community id   permission checked server-side; immutable
--   * uploader id    always the validated session user; immutable
--
-- Upload flow (two-phase):
--   1. rpc create_document_upload(...)  → metadata row (pending_upload) + path
--   2. Storage upload to exactly that path (storage INSERT policy requires a
--      matching pending row owned by the caller)
--   3. rpc complete_document_upload(id) → verifies the stored object, then active
-- Downloads: signed URLs from Storage; the storage SELECT policy decides.
-- Deletion: soft (status = 'deleted'); the file is removed later by the
-- service-role purge job (Storage deletes require read access to the row,
-- and deleted files are intentionally unreadable to clients).

-- ---------------------------------------------------------------------------
-- Configuration (service role writes; clients may read for UI validation)
-- ---------------------------------------------------------------------------
create table public.document_upload_settings (
  id                  boolean primary key default true check (id),
  -- Application limit; must not exceed the bucket ceiling (50 MiB).
  max_file_size_bytes bigint not null default 26214400
                      check (max_file_size_bytes between 1 and 52428800),
  updated_at          timestamptz not null default now()
);
insert into public.document_upload_settings (id) values (true);

create table public.document_mime_types (
  mime_type text primary key check (mime_type = lower(mime_type) and mime_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  -- The storage object's extension comes from here, never from the file name.
  extension text not null check (extension ~ '^[a-z0-9]{1,8}$'),
  enabled   boolean not null default true
);

-- Deliberately excludes active content (HTML, SVG, JS, executables).
insert into public.document_mime_types (mime_type, extension) values
  ('application/pdf', 'pdf'),
  ('image/png', 'png'),
  ('image/jpeg', 'jpg'),
  ('image/webp', 'webp'),
  ('text/plain', 'txt'),
  ('text/csv', 'csv'),
  ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'),
  ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'),
  ('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx');

-- ---------------------------------------------------------------------------
-- Storage bucket (private). Storage itself also enforces the size ceiling
-- and MIME allow-list on upload.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800,
        (select array_agg(mime_type order by mime_type) from public.document_mime_types where enabled))
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Folders (community-scoped tree)
-- ---------------------------------------------------------------------------
create table public.document_folders (
  id               uuid primary key default gen_random_uuid(),
  community_id     uuid not null references public.communities (id) on delete restrict,
  parent_folder_id uuid,
  name             text not null check (char_length(btrim(name)) between 1 and 120 and name !~ '[/\\[:cntrl:]]'),
  created_by       uuid default private.current_active_user_id() references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint document_folders_id_community_key unique (id, community_id),
  constraint document_folders_not_own_parent check (parent_folder_id is distinct from id),
  -- A parent must be in the same community. If it is deleted, its
  -- subfolders move to the top level.
  constraint document_folders_parent_fk
    foreign key (parent_folder_id, community_id)
    references public.document_folders (id, community_id) on delete set null (parent_folder_id)
);

create unique index document_folders_unique_name
  on public.document_folders (community_id, coalesce(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index document_folders_parent_idx on public.document_folders (parent_folder_id);

create trigger document_folders_set_updated_at
  before update on public.document_folders
  for each row execute function private.set_updated_at();

-- Folder moves may not create cycles; community and creator are immutable.
create or replace function private.enforce_folder_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.community_id is distinct from old.community_id
                           or new.created_by is distinct from old.created_by) then
    raise exception 'folder community and creator are immutable' using errcode = '42501';
  end if;
  new.name := btrim(new.name);
  if new.parent_folder_id is not null and exists (
    with recursive ancestors(id, depth) as (
      select f.parent_folder_id, 1 from public.document_folders f where f.id = new.parent_folder_id
      union all
      select f.parent_folder_id, a.depth + 1
      from public.document_folders f join ancestors a on f.id = a.id
      where a.id is not null and a.depth < 64
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'a folder cannot be moved inside itself' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_folder_write() from public, anon, authenticated;

create trigger document_folders_enforce_write
  before insert or update on public.document_folders
  for each row execute function private.enforce_folder_write();

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  community_id   uuid not null references public.communities (id) on delete restrict,
  uploaded_by    uuid not null references public.profiles (id) on delete restrict,
  folder_id      uuid,
  -- Display name only (sanitised). Never used in the storage path.
  name           text not null check (char_length(name) between 1 and 255),
  mime_type      text not null references public.document_mime_types (mime_type) on delete restrict,
  file_extension text not null check (file_extension ~ '^[a-z0-9]{1,8}$'),
  -- Generated: cannot be chosen, changed or pointed at another community.
  storage_path   text generated always as (
                   'communities/' || community_id::text || '/documents/' || id::text || '/file.' || file_extension
                 ) stored,
  file_size      bigint not null check (file_size > 0),
  visibility     text not null default 'members' check (visibility in ('members', 'managers')),
  status         text not null default 'pending_upload'
                 check (status in ('pending_upload', 'active', 'archived', 'deleted')),
  uploaded_at    timestamptz,
  archived_at    timestamptz,
  deleted_at     timestamptz,
  -- Set by the purge job once the stored file has been removed.
  file_purged_at timestamptz,
  updated_by_user_id uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint documents_folder_fk
    foreign key (folder_id, community_id)
    references public.document_folders (id, community_id) on delete set null (folder_id)
);

comment on table public.documents is
  'Document metadata. Files are in the private Storage bucket "documents" at storage_path.';

create unique index documents_storage_path_key on public.documents (storage_path);
create index documents_community_created_idx on public.documents (community_id, status, created_at desc, id desc);
create index documents_folder_idx on public.documents (folder_id, created_at desc) where folder_id is not null;
create index documents_uploaded_by_idx on public.documents (uploaded_by);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function private.set_updated_at();

-- Display-name sanitiser: strips any path, control characters and
-- surrounding whitespace; rejects empty and dot-only names.
create or replace function private.sanitize_document_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := coalesce(p_name, '');
begin
  v := regexp_replace(v, '^.*[/\\]', '');
  v := regexp_replace(v, '[[:cntrl:]]', '', 'g');
  v := btrim(v);
  if v = '' or v ~ '^\.+$' then
    raise exception 'invalid file name' using errcode = '22023';
  end if;
  return left(v, 255);
end;
$$;

revoke all on function private.sanitize_document_name(text) from public, anon, authenticated;
-- Pure function used by the write trigger, which runs as the caller.
grant execute on function private.sanitize_document_name(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Authorization helpers (shared by metadata RLS and storage policies)
-- ---------------------------------------------------------------------------
-- active:         visibility 'members' → documents.view or manage;
--                 visibility 'managers' → documents.manage
-- pending_upload: the uploader (with documents.upload) or documents.manage
-- archived:       documents.manage
-- deleted:        documents.manage, or the uploader (sees what she deleted)
create or replace function private.can_view_document_row(
  p_community_id uuid, p_uploaded_by uuid, p_visibility text, p_status text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_status
    when 'active' then
      public.has_community_permission(p_community_id, 'documents.manage')
      or (p_visibility = 'members' and public.has_community_permission(p_community_id, 'documents.view'))
    when 'archived' then
      public.has_community_permission(p_community_id, 'documents.manage')
    else
      public.has_community_permission(p_community_id, 'documents.manage')
      or (p_uploaded_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'documents.upload'))
  end;
$$;

create or replace function private.can_manage_document_row(p_community_id uuid, p_uploaded_by uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_community_permission(p_community_id, 'documents.manage')
      or (p_uploaded_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'documents.upload'));
$$;

-- Storage: may the caller download this object? Only an exact
-- storage_path match counts, so crafted paths ("../", other communities,
-- unknown files) match nothing. Pending uploads are readable by their
-- uploader (and managers) only: Storage reads the row back after upload.
create or replace function private.can_read_document_object(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bucket_id = 'documents' and exists (
    select 1 from public.documents d
    where d.storage_path = p_name
      and d.status in ('active', 'archived', 'pending_upload')
      and private.can_view_document_row(d.community_id, d.uploaded_by, d.visibility, d.status)
  );
$$;

-- Storage: may the caller upload this object? Only to the exact path of a
-- pending document she created and while she can still upload there.
create or replace function private.can_upload_document_object(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bucket_id = 'documents' and exists (
    select 1 from public.documents d
    where d.storage_path = p_name
      and d.status = 'pending_upload'
      and d.uploaded_by = (select private.current_active_user_id())
      and public.has_community_permission(d.community_id, 'documents.upload')
  );
$$;

-- Storage: may the caller remove this object? Clients may only discard an
-- abandoned pending upload (uploader or manager). Files of active and
-- archived documents can never be removed or replaced by clients; files of
-- deleted documents are removed by the service-role purge job after a
-- retention period (see public.list_document_files_to_purge).
create or replace function private.can_delete_document_object(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bucket_id = 'documents' and exists (
    select 1 from public.documents d
    where d.storage_path = p_name
      and d.status = 'pending_upload'
      and private.can_manage_document_row(d.community_id, d.uploaded_by)
  );
$$;

revoke all on function private.can_view_document_row(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function private.can_manage_document_row(uuid, uuid)           from public, anon, authenticated;
revoke all on function private.can_read_document_object(text, text)          from public, anon, authenticated;
revoke all on function private.can_upload_document_object(text, text)        from public, anon, authenticated;
revoke all on function private.can_delete_document_object(text, text)        from public, anon, authenticated;
grant execute on function private.can_view_document_row(uuid, uuid, text, text) to authenticated;
grant execute on function private.can_manage_document_row(uuid, uuid)           to authenticated;
grant execute on function private.can_read_document_object(text, text)          to authenticated;
grant execute on function private.can_upload_document_object(text, text)        to authenticated;
grant execute on function private.can_delete_document_object(text, text)        to authenticated;

-- ---------------------------------------------------------------------------
-- Write enforcement for document metadata
-- ---------------------------------------------------------------------------
-- WHO may update is decided by RLS (manager or uploader). This trigger
-- decides WHAT may change:
--   * immutable: community, uploader, MIME type, extension, size, created_at
--     (size / status pending→active are set only by complete_document_upload)
--   * status: active ↔ archived (documents.manage); active | archived →
--     deleted (manager or uploader); pending_upload → deleted (cancel);
--     deleted is terminal
--   * visibility: documents.manage only
--   * name: re-sanitised on every write
create or replace function private.enforce_document_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client  boolean := current_user in ('authenticated', 'anon');
  v_manager boolean;
begin
  new.name := private.sanitize_document_name(new.name);

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.community_id is distinct from old.community_id
     or new.uploaded_by is distinct from old.uploaded_by
     or new.created_at is distinct from old.created_at
     or new.mime_type is distinct from old.mime_type
     or new.file_extension is distinct from old.file_extension then
    raise exception 'document community, uploader and file identity are immutable' using errcode = '42501';
  end if;

  if not v_client then
    return new;
  end if;

  if new.file_size is distinct from old.file_size then
    raise exception 'file size is recorded by the server' using errcode = '42501';
  end if;

  v_manager := public.has_community_permission(old.community_id, 'documents.manage');

  if old.status = 'deleted' then
    raise exception 'deleted documents cannot be modified' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if (old.status = 'active' and new.status = 'archived') or (old.status = 'archived' and new.status = 'active') then
      if not v_manager then
        raise exception 'archiving requires documents.manage' using errcode = '42501';
      end if;
    elsif new.status = 'deleted' then
      null; -- manager or uploader (RLS)
    else
      raise exception 'invalid document transition: % -> %', old.status, new.status using errcode = '22023';
    end if;
    if new.status = 'archived' then new.archived_at := now(); end if;
    if new.status = 'active' then new.archived_at := null; end if;
    if new.status = 'deleted' then new.deleted_at := now(); end if;
  end if;

  if new.visibility is distinct from old.visibility and not v_manager then
    raise exception 'changing visibility requires documents.manage' using errcode = '42501';
  end if;

  new.updated_by_user_id := private.current_active_user_id();
  return new;
end;
$$;

revoke all on function private.enforce_document_write() from public, anon, authenticated;

create trigger documents_enforce_write
  before insert or update on public.documents
  for each row execute function private.enforce_document_write();

-- ---------------------------------------------------------------------------
-- Upload RPCs
-- ---------------------------------------------------------------------------
-- Phase 1. SECURITY DEFINER: clients have no INSERT on documents, so every
-- field is decided here from validated inputs.
create or replace function public.create_document_upload(
  p_community_id uuid,
  p_name         text,
  p_mime_type    text,
  p_file_size    bigint,
  p_folder_id    uuid default null,
  p_visibility   text default 'members'
)
returns table (document_id uuid, bucket_id text, storage_path text, max_file_size_bytes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user      uuid := private.current_active_user_id();
  v_extension text;
  v_max       bigint;
  v_mime      text := lower(btrim(coalesce(p_mime_type, '')));
begin
  if v_user is null or not public.has_community_permission(p_community_id, 'documents.upload') then
    raise exception 'documents.upload is required in this community' using errcode = '42501';
  end if;
  if coalesce(p_visibility, 'members') not in ('members', 'managers') then
    raise exception 'invalid visibility' using errcode = '22023';
  end if;
  if p_visibility = 'managers' and not public.has_community_permission(p_community_id, 'documents.manage') then
    raise exception 'restricted documents require documents.manage' using errcode = '42501';
  end if;

  select t.extension into v_extension from public.document_mime_types t where t.mime_type = v_mime and t.enabled;
  if v_extension is null then
    raise exception 'file type % is not allowed', v_mime using errcode = '22023';
  end if;

  select s.max_file_size_bytes into v_max from public.document_upload_settings s;
  if p_file_size is null or p_file_size < 1 or p_file_size > v_max then
    raise exception 'file size must be between 1 and % bytes', v_max using errcode = '22023';
  end if;

  if p_folder_id is not null and not exists (
    select 1 from public.document_folders f where f.id = p_folder_id and f.community_id = p_community_id
  ) then
    raise exception 'folder not found in this community' using errcode = '22023';
  end if;

  return query
  insert into public.documents as d (community_id, uploaded_by, folder_id, name, mime_type, file_extension, file_size, visibility)
  values (p_community_id, v_user, p_folder_id, p_name, v_mime, v_extension, p_file_size, coalesce(p_visibility, 'members'))
  returning d.id, 'documents'::text, d.storage_path, v_max;
end;
$$;

-- Phase 3. Verifies what Storage actually stored (size and content type
-- recorded by the Storage service), then activates the document.
create or replace function public.complete_document_upload(p_document_id uuid)
returns public.documents
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc    public.documents;
  v_meta   jsonb;
  v_size   bigint;
  v_max    bigint;
begin
  select * into v_doc from public.documents d
  where d.id = p_document_id
    and d.status = 'pending_upload'
    and d.uploaded_by = private.current_active_user_id()
    and public.has_community_permission(d.community_id, 'documents.upload')
  for update;
  if v_doc.id is null then
    raise exception 'no pending upload found' using errcode = 'P0002';
  end if;

  select o.metadata into v_meta from storage.objects o
  where o.bucket_id = 'documents' and o.name = v_doc.storage_path;
  if v_meta is null then
    raise exception 'the file has not been uploaded' using errcode = 'P0002';
  end if;

  v_size := (v_meta ->> 'size')::bigint;
  select s.max_file_size_bytes into v_max from public.document_upload_settings s;
  if v_size is null or v_size < 1 or v_size > v_max then
    raise exception 'stored file size % is outside the allowed range (max % bytes)', v_size, v_max using errcode = '22023';
  end if;
  if lower(coalesce(v_meta ->> 'mimetype', '')) <> v_doc.mime_type then
    raise exception 'stored content type % does not match %', v_meta ->> 'mimetype', v_doc.mime_type using errcode = '22023';
  end if;

  update public.documents d
  set status = 'active', file_size = v_size, uploaded_at = now()
  where d.id = v_doc.id
  returning * into v_doc;
  return v_doc;
end;
$$;

-- Purge job (service role only): files to remove from Storage. Deleted
-- documents older than the retention period, and pending uploads abandoned
-- for more than a day. The job removes the files through the Storage API,
-- then sets documents.file_purged_at (deleted) or deletes the pending row.
create or replace function public.list_document_files_to_purge(p_retention interval default interval '30 days')
returns table (document_id uuid, storage_path text, status text)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.storage_path, d.status
  from public.documents d
  where (d.status = 'deleted' and d.file_purged_at is null and d.deleted_at <= now() - p_retention)
     or (d.status = 'pending_upload' and d.created_at <= now() - interval '1 day')
  order by coalesce(d.deleted_at, d.created_at)
  limit 1000;
$$;

revoke all on function public.list_document_files_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_document_files_to_purge(interval) to service_role;

revoke all on function public.create_document_upload(uuid, text, text, bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_document_upload(uuid)                             from public, anon, authenticated;
grant execute on function public.create_document_upload(uuid, text, text, bigint, uuid, text) to authenticated;
grant execute on function public.complete_document_upload(uuid)                             to authenticated;

-- ---------------------------------------------------------------------------
-- Listing (SECURITY INVOKER: RLS applies)
-- ---------------------------------------------------------------------------
-- Documents of a community, newest first. p_folder_id NULL + p_root_only
-- = top level only; p_folder_id set = that folder; otherwise everything.
create or replace function public.list_documents(
  p_community_id      uuid,
  p_folder_id         uuid default null,
  p_root_only         boolean default false,
  p_statuses          text[] default array['active'],
  p_limit             integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id         uuid default null
)
returns setof public.documents
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_created_at and p_cursor_id' using errcode = '22023';
  end if;
  return query
  select d.* from public.documents d
  where d.community_id = p_community_id
    and d.status = any (coalesce(p_statuses, array['active']))
    and (p_folder_id is null or d.folder_id = p_folder_id)
    and (not p_root_only or d.folder_id is null)
    and (p_cursor_id is null or (d.created_at, d.id) < (p_cursor_created_at, p_cursor_id))
  order by d.created_at desc, d.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;

revoke all on function public.list_documents(uuid, uuid, boolean, text[], integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_documents(uuid, uuid, boolean, text[], integer, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: metadata
-- ---------------------------------------------------------------------------
revoke all on table public.documents, public.document_folders, public.document_upload_settings, public.document_mime_types
  from public, anon, authenticated;
grant all on table public.documents, public.document_folders, public.document_upload_settings, public.document_mime_types
  to service_role;
alter table public.documents                enable row level security;
alter table public.document_folders         enable row level security;
alter table public.document_upload_settings enable row level security;
alter table public.document_mime_types      enable row level security;

grant select on public.document_upload_settings, public.document_mime_types to authenticated;
create policy document_upload_settings_select on public.document_upload_settings for select to authenticated using (true);
create policy document_mime_types_select on public.document_mime_types for select to authenticated using (true);

-- documents: no INSERT (create_document_upload) and no DELETE (soft delete).
grant select on public.documents to authenticated;
grant update (name, folder_id, visibility, status) on public.documents to authenticated;

create policy documents_select_visible on public.documents
  for select to authenticated
  using (private.can_view_document_row(community_id, uploaded_by, visibility, status));

create policy documents_update_authorized on public.documents
  for update to authenticated
  using (private.can_manage_document_row(community_id, uploaded_by))
  with check (private.can_manage_document_row(community_id, uploaded_by));

-- folders: visible with documents.view; managed with documents.manage.
grant select on public.document_folders to authenticated;
grant insert (community_id, parent_folder_id, name) on public.document_folders to authenticated;
grant update (parent_folder_id, name) on public.document_folders to authenticated;
grant delete on public.document_folders to authenticated;

create policy document_folders_select on public.document_folders
  for select to authenticated
  using (public.has_community_permission(community_id, 'documents.view')
         or public.has_community_permission(community_id, 'documents.manage'));

create policy document_folders_insert on public.document_folders
  for insert to authenticated
  with check (created_by = (select private.current_active_user_id())
              and public.has_community_permission(community_id, 'documents.manage'));

create policy document_folders_update on public.document_folders
  for update to authenticated
  using (public.has_community_permission(community_id, 'documents.manage'))
  with check (public.has_community_permission(community_id, 'documents.manage'));

create policy document_folders_delete on public.document_folders
  for delete to authenticated
  using (public.has_community_permission(community_id, 'documents.manage'));

-- ---------------------------------------------------------------------------
-- Storage policies (independent second layer on storage.objects)
-- ---------------------------------------------------------------------------
-- No UPDATE policy: stored files can never be replaced or renamed (upsert
-- and move are refused). anon has no policy at all.
drop policy if exists documents_objects_select on storage.objects;
drop policy if exists documents_objects_insert on storage.objects;
drop policy if exists documents_objects_delete on storage.objects;

create policy documents_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and private.can_read_document_object(bucket_id, name));

create policy documents_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and private.can_upload_document_object(bucket_id, name));

create policy documents_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and private.can_delete_document_object(bucket_id, name));

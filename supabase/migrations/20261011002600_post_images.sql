-- Feed redesign / Migration 26: pictures in posts.
--
-- Decision: a PRIVATE Storage bucket, `post-images`. Posts are visible only to
-- members with posts.view (hidden / deleted ones only to moderators and their
-- author), so their pictures follow exactly the same rule: the app shows them
-- through short-lived signed URLs. A public bucket would let anyone holding a
-- URL see a community's photos forever, independent of membership.
--
-- Layout:  post-images/{community_id}/{user_id}/{random uuid}.{jpg|png|webp}
--   * upload: only into your own folder of a community where you hold
--     posts.create (active account);
--   * files are never overwritten (no UPDATE policy);
--   * read: anyone who can see a post that uses the file, and the uploader;
--   * delete: the uploader, only while no post uses the file (cleanup after a
--     failed publish). Pictures of deleted posts stay with the post, like its
--     text (moderation record), and go with it when the author's account is
--     deleted (posts cascade → post_images cascade → file purge).
--
-- public.post_images: one row per picture, ordered by position (at most 10).
-- Pictures can be attached ONLY in the transaction that creates the post
-- (posts.created_at = now()), i.e. through create_post(): a post's pictures
-- cannot be added, swapped or removed afterwards, by anyone.
--
-- create_post(): one call creates the post and attaches its pictures
-- atomically (no post without its pictures, no pictures without a post).
-- p_client_request_id makes it idempotent: retrying after a network failure
-- returns the post created by the first attempt instead of a duplicate.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- posts.client_request_id (idempotent creation)
-- ---------------------------------------------------------------------------
alter table public.posts add column client_request_id uuid;

comment on column public.posts.client_request_id is
  'Optional id chosen by the app for one "publish" action; unique per author, so a retried request cannot create a second post.';

create unique index posts_author_client_request_key
  on public.posts (author_user_id, client_request_id)
  where client_request_id is not null;

grant insert (client_request_id) on public.posts to authenticated;

-- ---------------------------------------------------------------------------
-- post_images
-- ---------------------------------------------------------------------------
create table public.post_images (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null,
  community_id uuid not null,
  storage_path text not null unique
               check (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  position     smallint not null check (position between 0 and 9),
  -- Pixel size, for laying the picture out before it loads (display only).
  width        integer not null check (width between 1 and 20000),
  height       integer not null check (height between 1 and 20000),
  created_at   timestamptz not null default now(),
  -- A picture belongs to its post's community; the post's deletion takes it along.
  constraint post_images_post_fkey foreign key (post_id, community_id)
    references public.posts (id, community_id) on delete cascade,
  constraint post_images_post_position_key unique (post_id, position)
);

comment on table public.post_images is
  'Pictures of a post (private post-images bucket), attached only when the post is created. See docs/features/feed-images.md.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- {community_id}/{user_id}/{uuid}.{ext} → its two folder ids; NULLs if malformed.
create or replace function private.post_image_folder(p_name text, out community_id uuid, out user_id uuid)
language sql
immutable
set search_path = ''
as $$
  select
    case when ok then split_part(p_name, '/', 1)::uuid end,
    case when ok then split_part(p_name, '/', 2)::uuid end
  from (select coalesce(p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$', false) as ok) s;
$$;

-- Upload: your own folder, in a community where you may post.
create or replace function private.can_upload_post_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select f.user_id is not null
     and f.user_id = (select private.current_active_user_id())
     and public.has_community_permission(f.community_id, 'posts.create')
  from private.post_image_folder(p_name) f;
$$;

-- Read: anyone who can see a post using the file; and the uploader (own file).
create or replace function private.can_read_post_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1
      from public.post_images pi
      join public.posts p on p.id = pi.post_id
      where pi.storage_path = p_name
        and private.can_view_post_row(p.community_id, p.author_user_id, p.status)
    )
    or (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
        from private.post_image_folder(p_name) f);
$$;

-- Delete: the uploader, only while no post uses the file.
create or replace function private.can_delete_post_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
          from private.post_image_folder(p_name) f)
     and not exists (select 1 from public.post_images pi where pi.storage_path = p_name);
$$;

revoke all on function private.post_image_folder(text)               from public, anon, authenticated;
revoke all on function private.can_upload_post_image_object(text)   from public, anon, authenticated;
revoke all on function private.can_read_post_image_object(text)     from public, anon, authenticated;
revoke all on function private.can_delete_post_image_object(text)   from public, anon, authenticated;
grant execute on function private.can_upload_post_image_object(text) to authenticated;
grant execute on function private.can_read_post_image_object(text)   to authenticated;
grant execute on function private.can_delete_post_image_object(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Attaching a picture: only to your own post, in the transaction that creates
-- it, with a file you uploaded to that community's folder.
-- ---------------------------------------------------------------------------
create or replace function private.check_post_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post   public.posts%rowtype;
  v_folder record;
begin
  select * into v_post from public.posts p where p.id = new.post_id;
  if not found
     or v_post.author_user_id is distinct from (select private.current_active_user_id())
     or v_post.status <> 'published'
     -- now() is the transaction start: true only where the post was just created.
     or v_post.created_at <> now() then
    raise exception 'pictures can only be added when creating your own post' using errcode = '42501';
  end if;
  new.community_id := v_post.community_id;
  select * into v_folder from private.post_image_folder(new.storage_path);
  if v_folder.community_id is distinct from v_post.community_id
     or v_folder.user_id is distinct from v_post.author_user_id then
    raise exception 'a picture must be uploaded to your own folder of this community' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'post-images' and o.name = new.storage_path) then
    raise exception 'picture upload not found; upload the picture first' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_post_image() from public, anon, authenticated;

create trigger post_images_check
  before insert on public.post_images
  for each row execute function private.check_post_image();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.post_images from public, anon, authenticated;
grant all on table public.post_images to service_role;
grant select on public.post_images to authenticated;
grant insert (post_id, community_id, storage_path, position, width, height) on public.post_images to authenticated;
-- No UPDATE or DELETE: pictures live and go with their post.

alter table public.post_images enable row level security;

create policy post_images_select_visible on public.post_images
  for select to authenticated
  using (private.can_view_post(post_id));

-- The trigger above checks authorship, timing, folder and file.
create policy post_images_insert_own_new_post on public.post_images
  for insert to authenticated
  with check (exists (
    select 1 from public.posts p
    where p.id = post_id
      and p.author_user_id = (select private.current_active_user_id())
      and public.has_community_permission(p.community_id, 'posts.create')
  ));

-- ---------------------------------------------------------------------------
-- Storage policies (post-images bucket). No UPDATE policy: no overwrite or move.
-- ---------------------------------------------------------------------------
drop policy if exists post_images_objects_select on storage.objects;
drop policy if exists post_images_objects_insert on storage.objects;
drop policy if exists post_images_objects_delete on storage.objects;

create policy post_images_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'post-images' and private.can_read_post_image_object(name));

create policy post_images_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'post-images' and private.can_upload_post_image_object(name));

create policy post_images_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-images' and private.can_delete_post_image_object(name));

-- ---------------------------------------------------------------------------
-- create_post(): the post and its pictures in one transaction, idempotent.
-- SECURITY INVOKER: posts and post_images RLS, the rate limit and the checks
-- above all apply as for direct writes.
--   p_images: [{ "path": "...", "width": 1080, "height": 1350 }, ...] (≤ 10),
--   in display order.
-- ---------------------------------------------------------------------------
create or replace function public.create_post(
  p_community_id      uuid,
  p_body              text,
  p_images            jsonb default '[]'::jsonb,
  p_client_request_id uuid default null
)
returns setof public.posts
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_me    uuid := private.current_active_user_id();
  v_post  public.posts%rowtype;
  v_image jsonb;
  v_index integer := 0;
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_images is null or jsonb_typeof(p_images) <> 'array' then
    raise exception 'p_images must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_images) > 10 then
    raise exception 'a post can have at most 10 pictures' using errcode = '22023';
  end if;

  -- A retry of a publish that already succeeded: the same post, nothing new.
  if p_client_request_id is not null then
    select * into v_post from public.posts p
    where p.author_user_id = v_me and p.client_request_id = p_client_request_id;
    if found then
      if v_post.community_id <> p_community_id then
        raise exception 'this request id was used for another post' using errcode = '22023';
      end if;
      return next v_post;
      return;
    end if;
  end if;

  begin
    insert into public.posts (community_id, body, client_request_id)
    values (p_community_id, p_body, p_client_request_id)
    returning * into v_post;
  exception when unique_violation then
    -- A concurrent attempt with the same request id won the race.
    select * into v_post from public.posts p
    where p.author_user_id = v_me and p.client_request_id = p_client_request_id;
    if not found then raise; end if;
    return next v_post;
    return;
  end;

  for v_image in select value from jsonb_array_elements(p_images) loop
    if jsonb_typeof(v_image) <> 'object'
       or jsonb_typeof(v_image -> 'path') <> 'string'
       or jsonb_typeof(v_image -> 'width') <> 'number'
       or jsonb_typeof(v_image -> 'height') <> 'number' then
      raise exception 'each picture needs path, width and height' using errcode = '22023';
    end if;
    insert into public.post_images (post_id, community_id, storage_path, position, width, height)
    values (v_post.id, v_post.community_id, v_image ->> 'path', v_index,
            (v_image ->> 'width')::integer, (v_image ->> 'height')::integer);
    v_index := v_index + 1;
  end loop;

  return next v_post;
end;
$$;

revoke all on function public.create_post(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_post(uuid, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Purge listing (service role): uploaded pictures no post uses (abandoned or
-- failed publishes, and pictures of deleted accounts' posts). The job deletes
-- them through the Storage API.
-- ---------------------------------------------------------------------------
create or replace function public.list_post_image_files_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'post-images'
    and o.created_at < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour')
    and not exists (select 1 from public.post_images pi where pi.storage_path = o.name)
  order by o.created_at
  limit 1000;
$$;

revoke all on function public.list_post_image_files_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_post_image_files_to_purge(interval) to service_role;

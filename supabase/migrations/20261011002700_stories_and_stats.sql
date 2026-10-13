-- Design pass / Migration 27: community stories, and the counts the
-- redesigned screens show (community hub tiles, profile stats).
--
-- STORIES
-- A story is one picture (with an optional short caption) shared with ONE
-- community for 24 hours. Like posts, it is private to that community:
--   * add:  members with posts.create (same right as posting);
--   * see:  members with posts.view, while the story is active (not expired,
--           not deleted); the author sees their own active stories;
--   * delete: the author, or a moderator (posts.moderate);
--   * expired stories are invisible to every client and are purged.
--
-- Pictures live in a PRIVATE bucket, `stories`, shown through short-lived
-- signed URLs:  stories/{community_id}/{user_id}/{random uuid}.{jpg|png|webp}
--   * upload: only into your own folder of a community where you hold
--     posts.create; never overwritten (no UPDATE policy);
--   * read: anyone who can see an active story using the file, and the
--     uploader (preview before publishing);
--   * delete: the uploader, only while no story uses the file.
--
-- Writes go through SECURITY DEFINER functions with explicit checks
-- (clients have no INSERT/UPDATE/DELETE on the tables):
--   create_story()        idempotent per author and client_request_id
--   delete_story()        author or moderator (soft delete)
--   mark_story_viewed()   records that the caller saw a story they can see
--   list_community_stories() the active stories, with "seen by me"
--
-- Story views are private: a viewer's own rows, and only COUNTS for the
-- author of a story (who saw it is not exposed).
--
-- STATS
--   community_stats(id)  counts for the hub tiles, each only if the caller
--                        may see that kind of content (otherwise NULL)
--   my_profile_stats()   the caller's own counts for the profile header

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stories', 'stories', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('story.create', 30, 3600, 'Stories per user per hour')
on conflict (action) do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.stories (
  id                uuid primary key default gen_random_uuid(),
  community_id      uuid not null references public.communities (id) on delete cascade,
  author_user_id    uuid not null references public.profiles (id) on delete cascade,
  storage_path      text not null unique
                    check (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  caption           text check (char_length(caption) <= 200),
  width             integer not null check (width between 1 and 20000),
  height            integer not null check (height between 1 and 20000),
  client_request_id uuid,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '24 hours',
  deleted_at        timestamptz,
  deleted_by        uuid references public.profiles (id) on delete set null,
  constraint stories_expiry check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);

comment on table public.stories is
  'Pictures shared with one community for 24 hours (private stories bucket). See docs/features/stories.md.';

create unique index stories_author_client_request_key
  on public.stories (author_user_id, client_request_id)
  where client_request_id is not null;
create index stories_community_active_idx on public.stories (community_id, expires_at desc) where deleted_at is null;
create index stories_author_idx on public.stories (author_user_id);

create table public.story_views (
  story_id       uuid not null references public.stories (id) on delete cascade,
  viewer_user_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at      timestamptz not null default now(),
  primary key (story_id, viewer_user_id)
);

create index story_views_viewer_idx on public.story_views (viewer_user_id);

comment on table public.story_views is
  'Who has seen which story (for the "seen" ring). Readable only by the viewer; authors get counts only.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- {community_id}/{user_id}/{uuid}.{ext} → its two folder ids; NULLs if malformed.
create or replace function private.story_folder(p_name text, out community_id uuid, out user_id uuid)
language sql
immutable
set search_path = ''
as $$
  select
    case when ok then split_part(p_name, '/', 1)::uuid end,
    case when ok then split_part(p_name, '/', 2)::uuid end
  from (select coalesce(p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$', false) as ok) s;
$$;

-- An active story the caller may see.
create or replace function private.can_view_story_row(p_community_id uuid, p_author uuid, p_expires_at timestamptz, p_deleted_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_deleted_at is null
     and p_expires_at > now()
     and (public.has_community_permission(p_community_id, 'posts.view')
          or (p_author = (select private.current_active_user_id())
              and public.has_community_permission(p_community_id, 'posts.create')));
$$;

create or replace function private.can_upload_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select f.user_id is not null
     and f.user_id = (select private.current_active_user_id())
     and public.has_community_permission(f.community_id, 'posts.create')
  from private.story_folder(p_name) f;
$$;

create or replace function private.can_read_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.stories s
      where s.storage_path = p_name
        and private.can_view_story_row(s.community_id, s.author_user_id, s.expires_at, s.deleted_at)
    )
    or (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
              and not exists (select 1 from public.stories s where s.storage_path = p_name)
        from private.story_folder(p_name) f);
$$;

create or replace function private.can_delete_story_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
          from private.story_folder(p_name) f)
     and not exists (select 1 from public.stories s where s.storage_path = p_name);
$$;

revoke all on function private.story_folder(text)                                         from public, anon, authenticated;
revoke all on function private.can_view_story_row(uuid, uuid, timestamptz, timestamptz)    from public, anon, authenticated;
revoke all on function private.can_upload_story_object(text)                               from public, anon, authenticated;
revoke all on function private.can_read_story_object(text)                                 from public, anon, authenticated;
revoke all on function private.can_delete_story_object(text)                               from public, anon, authenticated;
grant execute on function private.can_view_story_row(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function private.can_upload_story_object(text)  to authenticated;
grant execute on function private.can_read_story_object(text)    to authenticated;
grant execute on function private.can_delete_story_object(text)  to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and RLS (reads only; writes go through the functions below)
-- ---------------------------------------------------------------------------
revoke all on table public.stories, public.story_views from public, anon, authenticated;
grant all on table public.stories, public.story_views to service_role;
grant select on public.stories, public.story_views to authenticated;

alter table public.stories     enable row level security;
alter table public.story_views enable row level security;

create policy stories_select_active on public.stories
  for select to authenticated
  using (private.can_view_story_row(community_id, author_user_id, expires_at, deleted_at));

create policy story_views_select_own on public.story_views
  for select to authenticated
  using (viewer_user_id = (select private.current_active_user_id()));

-- ---------------------------------------------------------------------------
-- Storage policies (stories bucket). No UPDATE policy: no overwrite or move.
-- ---------------------------------------------------------------------------
drop policy if exists stories_objects_select on storage.objects;
drop policy if exists stories_objects_insert on storage.objects;
drop policy if exists stories_objects_delete on storage.objects;

create policy stories_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'stories' and private.can_read_story_object(name));

create policy stories_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'stories' and private.can_upload_story_object(name));

create policy stories_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'stories' and private.can_delete_story_object(name));

-- ---------------------------------------------------------------------------
-- create_story(): publish an uploaded picture as a story (idempotent).
-- ---------------------------------------------------------------------------
create or replace function public.create_story(
  p_community_id      uuid,
  p_path              text,
  p_width             integer,
  p_height            integer,
  p_caption           text default null,
  p_client_request_id uuid default null
)
returns setof public.stories
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me     uuid := private.current_active_user_id();
  v_story  public.stories%rowtype;
  v_folder record;
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.has_community_permission(p_community_id, 'posts.create') then
    raise exception 'posts.create is required to add a story in this community' using errcode = '42501';
  end if;

  -- A retry of a publish that already succeeded: the same story, nothing new.
  if p_client_request_id is not null then
    select * into v_story from public.stories s
    where s.author_user_id = v_me and s.client_request_id = p_client_request_id;
    if found then
      if v_story.community_id <> p_community_id then
        raise exception 'this request id was used for another story' using errcode = '22023';
      end if;
      return next v_story;
      return;
    end if;
  end if;

  select * into v_folder from private.story_folder(p_path);
  if v_folder.community_id is distinct from p_community_id or v_folder.user_id is distinct from v_me then
    raise exception 'a story picture must be uploaded to your own folder of this community' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'stories' and o.name = p_path) then
    raise exception 'story picture not found; upload the picture first' using errcode = '22023';
  end if;
  if v_caption is not null and char_length(v_caption) > 200 then
    raise exception 'a story caption can be at most 200 characters' using errcode = '22023';
  end if;
  if p_width is null or p_height is null or p_width not between 1 and 20000 or p_height not between 1 and 20000 then
    raise exception 'invalid picture size' using errcode = '22023';
  end if;

  perform private.enforce_rate_limit('story.create');

  begin
    insert into public.stories (community_id, author_user_id, storage_path, caption, width, height, client_request_id)
    values (p_community_id, v_me, p_path, v_caption, p_width, p_height, p_client_request_id)
    returning * into v_story;
  exception when unique_violation then
    select * into v_story from public.stories s
    where s.author_user_id = v_me and s.client_request_id = p_client_request_id;
    if not found then
      raise exception 'this picture is already used by a story' using errcode = '23505';
    end if;
  end;
  return next v_story;
end;
$$;

-- delete_story(): the author, or a moderator of the community. Returns false
-- when there is nothing the caller may delete (missing, expired, not theirs).
create or replace function public.delete_story(p_story_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.current_active_user_id();
  v_story public.stories%rowtype;
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_story from public.stories s where s.id = p_story_id for update;
  if not found
     or not private.can_view_story_row(v_story.community_id, v_story.author_user_id, v_story.expires_at, v_story.deleted_at) then
    return false;
  end if;
  if v_story.author_user_id <> v_me and not public.has_community_permission(v_story.community_id, 'posts.moderate') then
    raise exception 'only the author or a moderator can delete a story' using errcode = '42501';
  end if;
  update public.stories set deleted_at = now(), deleted_by = v_me where id = p_story_id;
  return true;
end;
$$;

-- mark_story_viewed(): only stories the caller can see; once per viewer.
create or replace function public.mark_story_viewed(p_story_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.current_active_user_id();
  v_story public.stories%rowtype;
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_story from public.stories s where s.id = p_story_id;
  if not found
     or not private.can_view_story_row(v_story.community_id, v_story.author_user_id, v_story.expires_at, v_story.deleted_at) then
    return false;
  end if;
  insert into public.story_views (story_id, viewer_user_id) values (p_story_id, v_me)
  on conflict do nothing;
  return true;
end;
$$;

-- list_community_stories(): active stories of a community, grouped by author
-- (the caller's own first, then authors with unseen stories, newest first),
-- oldest first within an author. view_count only for the caller's own stories.
create or replace function public.list_community_stories(p_community_id uuid)
returns table (
  id                  uuid,
  community_id        uuid,
  author_user_id      uuid,
  author_display_name text,
  storage_path        text,
  caption             text,
  width               integer,
  height              integer,
  created_at          timestamptz,
  expires_at          timestamptz,
  viewed_by_me        boolean,
  view_count          integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.current_active_user_id() as id),
  visible as (
    select s.*
    from public.stories s
    where s.community_id = p_community_id
      and private.can_view_story_row(s.community_id, s.author_user_id, s.expires_at, s.deleted_at)
  ),
  marked as (
    select v.*,
           exists (select 1 from public.story_views sv, me
                   where sv.story_id = v.id and sv.viewer_user_id = me.id) as seen
    from visible v
  ),
  authors as (
    select m.author_user_id,
           max(m.created_at) as latest,
           bool_and(m.seen) as all_seen
    from marked m
    group by m.author_user_id
  )
  select m.id, m.community_id, m.author_user_id,
         -- Profiles are readable to co-members; the same rule as the feed's author name.
         (select coalesce(pr.display_name, nullif(btrim(concat_ws(' ', pr.first_name, pr.last_name)), ''))
          from public.profiles pr
          where pr.id = m.author_user_id and pr.status = 'active'),
         m.storage_path, m.caption, m.width, m.height, m.created_at, m.expires_at,
         m.seen,
         case when m.author_user_id = (select id from me)
              then (select count(*)::integer from public.story_views sv where sv.story_id = m.id
                      and sv.viewer_user_id <> m.author_user_id)
         end
  from marked m
  join authors a on a.author_user_id = m.author_user_id
  order by (m.author_user_id = (select id from me)) desc, a.all_seen, a.latest desc, m.author_user_id,
           m.created_at, m.id
  limit 500;
$$;

-- Purge (service role): files of stories that expired or were deleted more
-- than p_grace ago, and uploads no story uses. The job removes the files via
-- the Storage API, then calls purge_expired_stories() to drop the rows.
create or replace function public.list_story_files_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  left join public.stories s on s.storage_path = o.name
  where o.bucket_id = 'stories'
    and (
      (s.id is null and o.created_at < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour'))
      or (s.id is not null and least(s.expires_at, coalesce(s.deleted_at, s.expires_at))
                              < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour'))
    )
  order by o.created_at
  limit 1000;
$$;

create or replace function public.purge_expired_stories(p_grace interval default interval '1 day')
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.stories s
    where least(s.expires_at, coalesce(s.deleted_at, s.expires_at))
          < now() - greatest(coalesce(p_grace, interval '1 day'), interval '1 hour')
      and not exists (select 1 from storage.objects o where o.bucket_id = 'stories' and o.name = s.storage_path)
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.create_story(uuid, text, integer, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_story(uuid)                                    from public, anon, authenticated;
revoke all on function public.mark_story_viewed(uuid)                               from public, anon, authenticated;
revoke all on function public.list_community_stories(uuid)                          from public, anon, authenticated;
revoke all on function public.list_story_files_to_purge(interval)                   from public, anon, authenticated;
revoke all on function public.purge_expired_stories(interval)                       from public, anon, authenticated;
grant execute on function public.create_story(uuid, text, integer, integer, text, uuid) to authenticated;
grant execute on function public.delete_story(uuid)                                    to authenticated;
grant execute on function public.mark_story_viewed(uuid)                               to authenticated;
grant execute on function public.list_community_stories(uuid)                          to authenticated;
grant execute on function public.list_story_files_to_purge(interval)                   to service_role;
grant execute on function public.purge_expired_stories(interval)                       to service_role;

-- ---------------------------------------------------------------------------
-- community_stats(): the hub tiles. Active members only; each count is NULL
-- unless the caller may see that kind of content, and counts only what the
-- caller could list (same rules as the list functions).
-- ---------------------------------------------------------------------------
create or replace function public.community_stats(p_community_id uuid)
returns table (
  member_count          integer,
  posts_today           integer,
  current_announcements integer,
  active_alerts         integer,
  upcoming_events       integer,
  document_count        integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_can_docs   boolean := public.has_community_permission(p_community_id, 'documents.view');
  v_doc_admin  boolean := public.has_community_permission(p_community_id, 'documents.manage');
begin
  if private.current_active_user_id() is null
     or not public.has_community_permission(p_community_id, 'community.view') then
    raise exception 'not a member of this community' using errcode = '42501';
  end if;
  return query select
    (select count(*)::integer from public.memberships m
      where m.community_id = p_community_id and m.status = 'active'),
    case when public.has_community_permission(p_community_id, 'posts.view') then
      (select count(*)::integer from public.posts p
        where p.community_id = p_community_id and p.status = 'published'
          and p.created_at > now() - interval '24 hours') end,
    case when public.has_community_permission(p_community_id, 'announcements.view') then
      (select count(*)::integer from public.announcements a
        where a.community_id = p_community_id and a.status = 'published'
          and (a.expires_at is null or a.expires_at > now())) end,
    case when public.has_community_permission(p_community_id, 'alerts.view') then
      (select count(*)::integer from public.alerts a
        where a.community_id = p_community_id and a.status = 'published'
          and (a.expires_at is null or a.expires_at > now())) end,
    case when public.has_community_permission(p_community_id, 'events.view') then
      (select count(*)::integer from public.events e
        where e.community_id = p_community_id and e.status = 'published' and e.ends_at > now()) end,
    case when v_can_docs or v_doc_admin then
      (select count(*)::integer from public.documents d
        where d.community_id = p_community_id and d.status = 'active'
          and (d.visibility = 'members' or v_doc_admin)) end;
end;
$$;

-- my_profile_stats(): the caller's own numbers (nothing about anyone else).
create or replace function public.my_profile_stats()
returns table (
  communities  integer,
  posts        integer,
  events_going integer,
  member_since timestamptz
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
  return query select
    (select count(*)::integer from public.memberships m
      join public.communities c on c.id = m.community_id
      where m.user_id = v_me and m.status = 'active' and c.status = 'active'),
    (select count(*)::integer from public.posts p
      where p.author_user_id = v_me and p.status = 'published'),
    (select count(*)::integer from public.event_rsvps r
      join public.events e on e.id = r.event_id
      where r.user_id = v_me and r.status = 'going' and e.status in ('published', 'completed')),
    (select pr.created_at from public.profiles pr where pr.id = v_me);
end;
$$;

revoke all on function public.community_stats(uuid) from public, anon, authenticated;
revoke all on function public.my_profile_stats()     from public, anon, authenticated;
grant execute on function public.community_stats(uuid) to authenticated;
grant execute on function public.my_profile_stats()     to authenticated;

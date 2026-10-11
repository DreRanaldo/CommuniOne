-- Stage 6 / Migration 12: announcements
--
-- Official community communications, separate from posts.
--
-- Permissions (existing keys, resolved per community):
--   announcements.view    read published and archived announcements
--   announcements.create  author announcements and manage YOUR OWN
--   announcements.manage  manage ANY announcement in the community
--
-- Lifecycle:
--   draft ──publish──► published ──archive──► archived ──republish──► published
--   draft | published | archived ──► deleted   (terminal, soft)
-- Expiry is time-based: a published announcement whose expires_at has
-- passed stays 'published' but is no longer "current"; it remains in the
-- history. No background job is required.

create table public.announcements (
  id                 uuid primary key default gen_random_uuid(),
  community_id       uuid not null references public.communities (id) on delete restrict,
  -- Defaulted from the validated session and not client-writable. Nullable
  -- with SET NULL: official communications outlive their author's account.
  author_user_id     uuid default private.current_active_user_id()
                     references public.profiles (id) on delete set null,
  title              text not null check (char_length(btrim(title)) between 1 and 200),
  body               text not null check (char_length(btrim(body)) between 1 and 20000),
  priority           text not null default 'normal' check (priority in ('normal', 'important')),
  status             text not null default 'draft'
                     check (status in ('draft', 'published', 'archived', 'deleted')),
  -- Stamped by trigger on (re)publication; not client-writable.
  published_at       timestamptz,
  expires_at         timestamptz,
  archived_at        timestamptz,
  edited_at          timestamptz,
  updated_by_user_id uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint announcements_published_has_timestamp
    check (status not in ('published', 'archived') or published_at is not null),
  constraint announcements_expiry_after_publication
    check (expires_at is null or published_at is null or expires_at > published_at)
);

comment on table public.announcements is
  'Official community announcements. Soft-deleted via status; see docs/features/announcements.md.';

-- Current / history lists: community + status, newest publication first.
create index announcements_community_status_published_idx
  on public.announcements (community_id, status, published_at desc, id desc);
-- Expiry checks on the published set.
create index announcements_community_expiry_idx
  on public.announcements (community_id, expires_at) where status = 'published';
create index announcements_author_idx on public.announcements (author_user_id);

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Visibility helper
-- ---------------------------------------------------------------------------
-- published / archived: announcements.view or announcements.manage
-- draft / deleted:      announcements.manage, or the author while they hold
--                       announcements.create. (The author must keep seeing a
--                       row they soft-delete: Postgres requires the row an
--                       UPDATE produces to stay visible to its author.)
create or replace function private.can_view_announcement_row(
  p_community_id uuid, p_author_user_id uuid, p_status text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status in ('published', 'archived') then
      public.has_community_permission(p_community_id, 'announcements.view')
      or public.has_community_permission(p_community_id, 'announcements.manage')
    else
      public.has_community_permission(p_community_id, 'announcements.manage')
      or (p_author_user_id = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'announcements.create'))
  end;
$$;

-- Manage a specific announcement: any with announcements.manage, your own
-- with announcements.create.
create or replace function private.can_manage_announcement_row(p_community_id uuid, p_author_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_community_permission(p_community_id, 'announcements.manage')
      or (p_author_user_id = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'announcements.create'));
$$;

revoke all on function private.can_view_announcement_row(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.can_manage_announcement_row(uuid, uuid)     from public, anon, authenticated;
grant execute on function private.can_view_announcement_row(uuid, uuid, text) to authenticated;
grant execute on function private.can_manage_announcement_row(uuid, uuid)     to authenticated;

-- ---------------------------------------------------------------------------
-- Lifecycle enforcement
-- ---------------------------------------------------------------------------
-- WHO may act is decided by RLS (can_manage_announcement_row). This trigger
-- decides WHAT may change:
--   * community_id, author_user_id, created_at are immutable; published_at
--     and archived_at are server-stamped
--   * allowed transitions only (see header); deleted is terminal
--   * publishing stamps published_at = now() and requires a future expiry
--   * title/body/priority/expires_at can change only while draft or
--     published; edits to a published announcement stamp edited_at
--   * every client change stamps updated_by_user_id
create or replace function private.enforce_announcement_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'published') then
      raise exception 'new announcements must be draft or published' using errcode = '22023';
    end if;
    if v_client then
      new.published_at := null;
      new.archived_at := null;
      new.edited_at := null;
      new.updated_by_user_id := null;
    end if;
    if new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
      if new.expires_at is not null and new.expires_at <= now() then
        raise exception 'expires_at must be in the future when publishing' using errcode = '22023';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.community_id is distinct from old.community_id
     or new.author_user_id is distinct from old.author_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'announcement community, author and created_at are immutable' using errcode = '42501';
  end if;

  if not v_client then
    return new;
  end if;

  if old.status = 'deleted' then
    raise exception 'deleted announcements cannot be modified' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'     and new.status in ('published', 'deleted'))
      or (old.status = 'published' and new.status in ('archived', 'deleted'))
      or (old.status = 'archived'  and new.status in ('published', 'deleted'))
    ) then
      raise exception 'invalid announcement transition: % -> %', old.status, new.status using errcode = '22023';
    end if;

    if new.status = 'published' then
      new.published_at := now();
      new.archived_at := null;
      if new.expires_at is not null and new.expires_at <= now() then
        raise exception 'expires_at must be in the future when publishing' using errcode = '22023';
      end if;
    elsif new.status = 'archived' then
      new.archived_at := now();
    end if;
  end if;

  if (new.title, new.body, new.priority) is distinct from (old.title, old.body, old.priority)
     or new.expires_at is distinct from old.expires_at then
    if new.status not in ('draft', 'published') then
      raise exception 'only draft or published announcements can be edited' using errcode = '42501';
    end if;
    if old.status = 'published' and new.status = 'published' then
      new.edited_at := now();
    end if;
  end if;

  new.updated_by_user_id := private.current_active_user_id();
  return new;
end;
$$;

revoke all on function private.enforce_announcement_write() from public, anon, authenticated;

create trigger announcements_enforce_write
  before insert or update on public.announcements
  for each row execute function private.enforce_announcement_write();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.announcements from public, anon, authenticated;
grant all on table public.announcements to service_role;
alter table public.announcements enable row level security;

grant select on public.announcements to authenticated;
grant insert (community_id, title, body, priority, status, expires_at) on public.announcements to authenticated;
grant update (title, body, priority, status, expires_at) on public.announcements to authenticated;
-- No DELETE grant: deletion is soft (status = 'deleted').

create policy announcements_select_visible on public.announcements
  for select to authenticated
  using (private.can_view_announcement_row(community_id, author_user_id, status));

create policy announcements_insert_authorized on public.announcements
  for insert to authenticated
  with check (
    author_user_id = (select private.current_active_user_id())
    and status in ('draft', 'published')
    and public.has_community_permission(community_id, 'announcements.create')
  );

create policy announcements_update_authorized on public.announcements
  for update to authenticated
  using (private.can_manage_announcement_row(community_id, author_user_id))
  with check (private.can_manage_announcement_row(community_id, author_user_id));

-- ---------------------------------------------------------------------------
-- Read API (SECURITY INVOKER: RLS filters every row)
-- ---------------------------------------------------------------------------
-- Current announcements: published and not expired. Important first, then
-- newest. Keyset cursor = the last row's (priority, published_at, id).
create or replace function public.list_current_announcements(
  p_community_id        uuid,
  p_limit               integer default 20,
  p_cursor_priority     text default null,
  p_cursor_published_at timestamptz default null,
  p_cursor_id           uuid default null
)
returns table (
  id             uuid,
  community_id   uuid,
  author_user_id uuid,
  title          text,
  body           text,
  priority       text,
  status         text,
  published_at   timestamptz,
  expires_at     timestamptz,
  edited_at      timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if num_nulls(p_cursor_priority, p_cursor_published_at, p_cursor_id) not in (0, 3) then
    raise exception 'cursor requires p_cursor_priority, p_cursor_published_at and p_cursor_id' using errcode = '22023';
  end if;

  return query
  select a.id, a.community_id, a.author_user_id, a.title, a.body, a.priority, a.status,
         a.published_at, a.expires_at, a.edited_at
  from public.announcements a
  where a.community_id = p_community_id
    and a.status = 'published'
    and (a.expires_at is null or a.expires_at > now())
    and (p_cursor_id is null
         or ((a.priority = 'important')::int, a.published_at, a.id)
            < ((p_cursor_priority = 'important')::int, p_cursor_published_at, p_cursor_id))
  order by (a.priority = 'important')::int desc, a.published_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- History: by default every published (including expired) and archived
-- announcement, newest first. Managers may request other statuses (draft,
-- deleted); RLS returns only what the caller may see.
create or replace function public.list_announcement_history(
  p_community_id      uuid,
  p_limit             integer default 20,
  p_cursor_sort_at    timestamptz default null,
  p_cursor_id         uuid default null,
  p_statuses          text[] default array['published', 'archived']
)
returns table (
  id             uuid,
  community_id   uuid,
  author_user_id uuid,
  title          text,
  body           text,
  priority       text,
  status         text,
  published_at   timestamptz,
  expires_at     timestamptz,
  archived_at    timestamptz,
  edited_at      timestamptz,
  is_expired     boolean,
  sort_at        timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_sort_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_sort_at and p_cursor_id' using errcode = '22023';
  end if;

  return query
  select a.id, a.community_id, a.author_user_id, a.title, a.body, a.priority, a.status,
         a.published_at, a.expires_at, a.archived_at, a.edited_at,
         (a.expires_at is not null and a.expires_at <= now()),
         coalesce(a.published_at, a.created_at)
  from public.announcements a
  where a.community_id = p_community_id
    and a.status = any (coalesce(p_statuses, array['published', 'archived']))
    and (p_cursor_id is null
         or (coalesce(a.published_at, a.created_at), a.id) < (p_cursor_sort_at, p_cursor_id))
  order by coalesce(a.published_at, a.created_at) desc, a.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

revoke all on function public.list_current_announcements(uuid, integer, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.list_announcement_history(uuid, integer, timestamptz, uuid, text[]) from public, anon, authenticated;
grant execute on function public.list_current_announcements(uuid, integer, text, timestamptz, uuid) to authenticated;
grant execute on function public.list_announcement_history(uuid, integer, timestamptz, uuid, text[]) to authenticated;

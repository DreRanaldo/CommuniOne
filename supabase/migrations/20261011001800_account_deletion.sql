-- Pre-Stage 12 / Migration 18: account deletion policy
--
-- When a user deletes their account (public.delete_my_account(), or an
-- operator deleting the auth user):
--   * auth.users row and every auth.* record (sessions, identities, MFA)
--     are deleted → the user can no longer authenticate
--   * public.profiles is deleted (CASCADE) → no name, avatar, bio or phone
--     remains (phone lives in profile_private, also CASCADE)
--   * PERSONAL data is deleted: memberships (+ role assignments),
--     reactions, RSVPs (places are released to the waitlist),
--     notifications, platform-admin grants
--   * COMMUNITY history is kept with the creator set to NULL (rendered as
--     "Deleted User"): posts, comments, announcements, alerts, events,
--     documents (metadata AND stored file), folders, communities
--   * audit_logs are kept unchanged: actor/subject ids are pseudonymous and
--     no longer resolve to any profile; metadata never held personal data
--   * a community is never left without someone able to manage roles: if
--     the user is its only active role manager and other active members
--     remain, deletion is refused until ownership is transferred; if the
--     user is its last active member, the community is archived
--
-- Changes:
--   1. creator columns become nullable with ON DELETE SET NULL
--      (posts/comments were CASCADE; alerts/events/documents were RESTRICT)
--   2. write triggers accept exactly one extra change: creator → NULL made
--      by the database itself (FK action), never by a client
--   3. profiles BEFORE DELETE guard (role-manager rule) for every deletion
--      path, including Supabase Dashboard / Admin API deletions
--   4. public.delete_my_account(): self-service, no user-id parameter
--   5. audit action account.deleted

-- ---------------------------------------------------------------------------
-- 1. Creator relationships: preserve content, forget the person
-- ---------------------------------------------------------------------------
alter table public.posts alter column author_user_id drop not null;
alter table public.posts drop constraint posts_author_user_id_fkey,
  add constraint posts_author_user_id_fkey foreign key (author_user_id) references public.profiles (id) on delete set null;

alter table public.comments alter column author_user_id drop not null;
alter table public.comments drop constraint comments_author_user_id_fkey,
  add constraint comments_author_user_id_fkey foreign key (author_user_id) references public.profiles (id) on delete set null;

alter table public.alerts alter column created_by drop not null;
alter table public.alerts drop constraint alerts_created_by_fkey,
  add constraint alerts_created_by_fkey foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.events alter column created_by drop not null;
alter table public.events drop constraint events_created_by_fkey,
  add constraint events_created_by_fkey foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.documents alter column uploaded_by drop not null;
alter table public.documents drop constraint documents_uploaded_by_fkey,
  add constraint documents_uploaded_by_fkey foreign key (uploaded_by) references public.profiles (id) on delete set null;

comment on column public.posts.author_user_id is 'NULL = author deleted their account (show "Deleted User").';
comment on column public.comments.author_user_id is 'NULL = author deleted their account (show "Deleted User").';
comment on column public.announcements.author_user_id is 'NULL = author deleted their account (show "Deleted User").';
comment on column public.alerts.created_by is 'NULL = creator deleted their account (show "Deleted User").';
comment on column public.events.created_by is 'NULL = creator deleted their account; managed by events.manage holders.';
comment on column public.documents.uploaded_by is 'NULL = uploader deleted their account (show "Uploaded by Deleted User").';

-- ---------------------------------------------------------------------------
-- 2. Write triggers: allow the database (not clients) to clear a creator
-- ---------------------------------------------------------------------------
-- True only for creator → NULL performed by trusted code: the ON DELETE SET
-- NULL foreign-key action runs as the table owner, never as a client role.
-- Clients cannot write creator columns at all (no column grants).
create or replace function private.is_account_erasure(p_old uuid, p_new uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_old is not null and p_new is null and current_user not in ('authenticated', 'anon');
$$;

revoke all on function private.is_account_erasure(uuid, uuid) from public, anon;
grant execute on function private.is_account_erasure(uuid, uuid) to authenticated, service_role;

-- private.enforce_content_update(): from 20261011001100_posts_comments_reactions.sql, creator check now admits account erasure.
create or replace function private.enforce_content_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind      text := tg_argv[0];
  v_me        uuid;
  v_is_author boolean;
  v_can_mod   boolean;
begin
  if new.community_id is distinct from old.community_id
     or (new.author_user_id is distinct from old.author_user_id and not private.is_account_erasure(old.author_user_id, new.author_user_id))
     or new.created_at is distinct from old.created_at then
    raise exception '% community, author and created_at are immutable', v_kind using errcode = '42501';
  end if;
  if v_kind = 'comments' and (
       (to_jsonb(new) ->> 'post_id') is distinct from (to_jsonb(old) ->> 'post_id')
       or ((to_jsonb(new) ->> 'parent_comment_id') is distinct from (to_jsonb(old) ->> 'parent_comment_id')
           and (to_jsonb(new) ->> 'parent_comment_id') is not null)) then
    -- (parent may only become NULL, via the parent FK's ON DELETE SET NULL)
    raise exception 'comment post and parent are immutable' using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  v_me        := private.current_active_user_id();
  v_is_author := old.author_user_id = v_me;
  v_can_mod   := public.has_community_permission(old.community_id, v_kind || '.moderate');

  if old.status = 'deleted' then
    raise exception 'deleted % cannot be modified', v_kind using errcode = '42501';
  end if;

  if new.body is distinct from old.body then
    if not (v_is_author
            and old.status = 'published' and new.status = 'published'
            and public.has_community_permission(old.community_id, v_kind || '.edit_own')) then
      raise exception 'you can only edit your own published %', v_kind using errcode = '42501';
    end if;
    new.edited_at := now();
  end if;

  if new.status is distinct from old.status then
    if v_is_author and new.status = 'deleted'
       and public.has_community_permission(old.community_id, v_kind || '.delete_own') then
      null; -- author deletes own content
    elsif v_can_mod and (
            (old.status = 'published' and new.status = 'hidden')
         or (old.status = 'hidden' and new.status = 'published')
         or new.status = 'deleted') then
      new.moderated_by_user_id := v_me;
      new.moderated_at := now();
      -- Restoring hidden content clears the (moderator-facing) reason so it
      -- is not shown to every member, unless a new reason is given.
      if new.status = 'published' and new.moderation_reason is not distinct from old.moderation_reason then
        new.moderation_reason := null;
      end if;
    else
      raise exception 'not permitted: % status % -> %', v_kind, old.status, new.status using errcode = '42501';
    end if;
  end if;

  if new.moderation_reason is distinct from old.moderation_reason and not v_can_mod then
    raise exception 'only moderators can set a moderation reason' using errcode = '42501';
  end if;

  return new;
end;
$$;

-- private.enforce_announcement_write(): from 20261011001200_announcements.sql, creator check now admits account erasure.
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
     or (new.author_user_id is distinct from old.author_user_id and not private.is_account_erasure(old.author_user_id, new.author_user_id))
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

-- private.enforce_alert_write(): from 20261011001300_alerts.sql, creator check now admits account erasure.
create or replace function private.enforce_alert_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client  boolean := current_user in ('authenticated', 'anon');
  -- Only client requests are attributed to a user; trusted server code
  -- (service_role, scheduler) is never attributed to leftover JWT claims.
  v_me      uuid := case when current_user in ('authenticated', 'anon') then private.current_active_user_id() end;
  v_manager boolean;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'published') then
      raise exception 'new alerts must be draft or published' using errcode = '22023';
    end if;
    if v_client then
      v_manager := public.has_community_permission(new.community_id, 'alerts.manage');
      if new.severity = 'emergency' and not v_manager then
        raise exception 'emergency alerts require alerts.manage' using errcode = '42501';
      end if;
      new.published_at := null; new.published_by := null;
      new.expired_at := null; new.cancelled_at := null; new.cancelled_by := null;
      new.cancellation_reason := null; new.archived_at := null; new.edited_at := null;
      new.updated_by_user_id := null;
    end if;
    if new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, v_me);
      if new.expires_at is not null and new.expires_at <= now() then
        raise exception 'expires_at must be in the future when publishing' using errcode = '22023';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if new.community_id is distinct from old.community_id
     or (new.created_by is distinct from old.created_by and not private.is_account_erasure(old.created_by, new.created_by))
     or new.created_at is distinct from old.created_at then
    raise exception 'alert community, creator and created_at are immutable' using errcode = '42501';
  end if;

  if not v_client then
    return new;
  end if;

  v_manager := public.has_community_permission(old.community_id, 'alerts.manage');

  if old.status = 'archived' then
    raise exception 'archived alerts cannot be modified' using errcode = '42501';
  end if;

  -- Severity: never trusted from the client.
  if new.severity is distinct from old.severity then
    if not v_manager and (old.status <> 'draft' or new.severity = 'emergency' or old.severity = 'emergency') then
      raise exception 'changing this alert''s severity requires alerts.manage' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'     and new.status in ('published', 'cancelled'))
      or (old.status = 'published' and new.status in ('cancelled', 'expired'))
      or (old.status in ('cancelled', 'expired') and new.status = 'archived')
    ) then
      raise exception 'invalid alert transition: % -> %', old.status, new.status using errcode = '22023';
    end if;

    if new.status = 'published' then
      if new.severity = 'emergency' and not v_manager then
        raise exception 'publishing an emergency alert requires alerts.manage' using errcode = '42501';
      end if;
      if new.expires_at is not null and new.expires_at <= now() then
        raise exception 'expires_at must be in the future when publishing' using errcode = '22023';
      end if;
      new.published_at := now();
      new.published_by := v_me;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
      new.cancelled_by := v_me;
    elsif new.status = 'expired' then
      new.expired_at := now();
    elsif new.status = 'archived' then
      new.archived_at := now();
    end if;
  end if;

  if new.cancellation_reason is distinct from old.cancellation_reason
     and not (new.status = 'cancelled' and old.status is distinct from 'cancelled') then
    raise exception 'a cancellation reason can only be given when cancelling' using errcode = '22023';
  end if;

  if (new.title, new.body, new.severity) is distinct from (old.title, old.body, old.severity)
     or new.expires_at is distinct from old.expires_at then
    if old.status not in ('draft', 'published') or new.status not in ('draft', 'published') then
      raise exception 'only draft or published alerts can be edited' using errcode = '42501';
    end if;
    if new.expires_at is not null and new.status = 'published' and new.expires_at <= now()
       and new.expires_at is distinct from old.expires_at then
      raise exception 'expires_at must be in the future; use status = expired to end an alert now' using errcode = '22023';
    end if;
    if old.status = 'published' then
      new.edited_at := now();
    end if;
  end if;

  new.updated_by_user_id := v_me;
  return new;
end;
$$;

-- private.enforce_event_write(): from 20261011001400_events.sql, creator check now admits account erasure.
create or replace function private.enforce_event_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
  v_me     uuid := case when current_user in ('authenticated', 'anon') then private.current_active_user_id() end;
  v_going  integer;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'published') then
      raise exception 'new events must be draft or published' using errcode = '22023';
    end if;
    if v_client then
      new.published_at := null; new.cancelled_at := null; new.cancelled_by := null;
      new.cancellation_reason := null; new.completed_at := null; new.edited_at := null;
      new.updated_by_user_id := null; new.rsvp_changed_at := null;
    end if;
    if new.status = 'published' then
      if new.ends_at <= now() then
        raise exception 'an event that has already ended cannot be published' using errcode = '22023';
      end if;
      new.published_at := coalesce(new.published_at, now());
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if new.community_id is distinct from old.community_id
     or (new.created_by is distinct from old.created_by and not private.is_account_erasure(old.created_by, new.created_by))
     or new.created_at is distinct from old.created_at then
    raise exception 'event community, creator and created_at are immutable' using errcode = '42501';
  end if;

  -- Capacity may never drop below the number already going. The event row
  -- is locked by this UPDATE, so the count cannot change underneath us.
  if new.capacity is distinct from old.capacity and new.capacity is not null then
    select count(*) into v_going from public.event_rsvps r where r.event_id = new.id and r.status = 'going';
    if new.capacity < v_going then
      raise exception 'capacity (%) cannot be lower than the number of people going (%)', new.capacity, v_going
        using errcode = '22023';
    end if;
  end if;

  if not v_client then
    return new;
  end if;

  if old.status in ('cancelled', 'completed') then
    raise exception '% events cannot be modified', old.status using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'     and new.status in ('published', 'cancelled'))
      or (old.status = 'published' and new.status in ('cancelled', 'completed'))
    ) then
      raise exception 'invalid event transition: % -> %', old.status, new.status using errcode = '22023';
    end if;

    if new.status = 'published' then
      if new.ends_at <= now() then
        raise exception 'an event that has already ended cannot be published' using errcode = '22023';
      end if;
      new.published_at := now();
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
      new.cancelled_by := v_me;
    elsif new.status = 'completed' then
      if old.starts_at > now() then
        raise exception 'an event cannot be completed before it starts' using errcode = '22023';
      end if;
      new.completed_at := now();
    end if;
  end if;

  if new.cancellation_reason is distinct from old.cancellation_reason
     and not (new.status = 'cancelled' and old.status <> 'cancelled') then
    raise exception 'a cancellation reason can only be given when cancelling' using errcode = '22023';
  end if;

  if (new.title, new.description, new.location_text, new.starts_at, new.ends_at, new.timezone)
       is distinct from (old.title, old.description, old.location_text, old.starts_at, old.ends_at, old.timezone)
     or new.capacity is distinct from old.capacity then
    if new.status not in ('draft', 'published') then
      raise exception 'only draft or published events can be edited' using errcode = '42501';
    end if;
    if old.status = 'published' then
      new.edited_at := now();
    end if;
  end if;

  new.updated_by_user_id := v_me;
  return new;
end;
$$;

-- private.enforce_document_write(): from 20261011001600_documents.sql, creator check now admits account erasure.
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
     or (new.uploaded_by is distinct from old.uploaded_by and not private.is_account_erasure(old.uploaded_by, new.uploaded_by))
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

-- private.enforce_folder_write(): from 20261011001600_documents.sql, creator check now admits account erasure.
create or replace function private.enforce_folder_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.community_id is distinct from old.community_id
                           or (new.created_by is distinct from old.created_by and not private.is_account_erasure(old.created_by, new.created_by))) then
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

-- ---------------------------------------------------------------------------
-- 3. Never orphan a community (applies to every deletion path)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: inspects memberships of all users and may archive a
-- community (platform-controlled column).
create or replace function private.guard_profile_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership record;
  v_blocking   text[] := '{}';
begin
  for v_membership in
    select m.id, m.community_id, c.name
    from public.memberships m
    join public.communities c on c.id = m.community_id
    where m.user_id = old.id and m.status = 'active' and c.status <> 'archived'
  loop
    if private.is_sole_role_manager(v_membership.id) then
      if exists (select 1 from public.memberships o
                 where o.community_id = v_membership.community_id
                   and o.user_id <> old.id and o.status = 'active') then
        v_blocking := v_blocking || v_membership.name;
      else
        -- Last active member: nobody is left to run it. The creator link is
        -- cleared here too (the FK would do it a moment later), because
        -- rewriting a row created earlier in this same transaction makes
        -- PostgreSQL re-check created_by against the vanishing auth user.
        update public.communities
           set status = 'archived',
               created_by = case when created_by = old.id then null else created_by end
         where id = v_membership.community_id;
      end if;
    end if;
  end loop;

  if cardinality(v_blocking) > 0 then
    raise exception 'transfer the ability to manage roles (e.g. the Owner role) before deleting this account; it is required in: %',
      array_to_string(v_blocking, ', ')
      using errcode = '55000';
  end if;
  return old;
end;
$$;

revoke all on function private.guard_profile_deletion() from public, anon, authenticated;

create trigger profiles_guard_deletion
  before delete on public.profiles
  for each row execute function private.guard_profile_deletion();

-- ---------------------------------------------------------------------------
-- 4. Self-service account deletion
-- ---------------------------------------------------------------------------
-- Deletes the CALLER's account. No user-id parameter: nobody can delete
-- someone else's account through this function. Works for suspended
-- accounts too (right to erasure) — only a live session is required.
-- SECURITY DEFINER: deleting auth.users requires the owner's privileges.
-- Atomic: the audit entry, the guard, and every cascade/SET NULL happen in
-- this one transaction, or nothing does.
create or replace function public.delete_my_account()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.current_session_user_id();
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform private.record_audit_event(null, 'account.deleted', 'profile', v_user, '{}'::jsonb);

  delete from auth.users where id = v_user;
end;
$$;

revoke all on function public.delete_my_account() from public, anon, authenticated;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Audit action
-- ---------------------------------------------------------------------------
insert into public.audit_actions (action, entity_type, description) values
  ('account.deleted', 'profile', 'A user deleted their account');

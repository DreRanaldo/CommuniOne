-- Stage 9 / Migration 15: notifications (in-app) and the notification service
--
-- * notifications belong to exactly one user; clients can read and manage
--   only their own and can NEVER create them
-- * notifications are created only by the trusted server-side service
--   (private.create_notification / private.notify_community), called from
--   database triggers in other modules or by backend code via the
--   service-role-only RPC public.create_notification
-- * a community-scoped notification can only be created for an active
--   member of that community, and stops being readable when the user loses
--   access to the community (no cross-tenant leakage through notifications)
-- * delivery channels (push / email / SMS) are NOT implemented; the schema
--   leaves room for them without changes to this table (see
--   docs/features/notifications.md)

-- ---------------------------------------------------------------------------
-- Notification types (lookup table; adding a type = inserting a row)
-- ---------------------------------------------------------------------------
create table public.notification_types (
  key                 text primary key check (key ~ '^[a-z][a-z_]*$'),
  description         text not null,
  -- Community-scoped notifications of this type are created for, and
  -- readable by, active members only. False for types about the user's own
  -- membership or account.
  requires_membership boolean not null default true,
  -- Default urgency for future channel routing (push/email/SMS).
  default_priority    text not null default 'normal' check (default_priority in ('low', 'normal', 'high', 'critical')),
  created_at          timestamptz not null default now()
);

comment on table public.notification_types is
  'Catalog of notification types. Only types with a producer are listed; add new ones together with their producer.';

insert into public.notification_types (key, description, requires_membership, default_priority) values
  ('announcement',    'An announcement was published in a community you belong to',         true,  'normal'),
  ('alert',           'An alert was published or withdrawn in a community you belong to',    true,  'high'),
  ('event_created',   'A new event was published in a community you belong to',              true,  'low'),
  ('event_updated',   'An event you responded to changed (time, place, or your waitlist place)', true, 'normal'),
  ('event_cancelled', 'An event you responded to was cancelled',                             true,  'high'),
  ('comment',         'Someone commented on your post or replied to your comment',           true,  'normal'),
  ('membership',      'Your membership status in a community changed',                       false, 'normal'),
  ('system',          'A platform message about your account',                               false, 'normal');

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  -- Notifications are derived data; they go with a hard-deleted community.
  community_id uuid references public.communities (id) on delete cascade,
  type         text not null references public.notification_types (key) on delete restrict,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  body         text check (char_length(body) <= 1000),
  -- Deep-link payload (ids, not copies of protected content).
  data         jsonb not null default '{}'::jsonb
               check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 8192),
  -- Idempotency: the same source event never notifies the same user twice.
  dedupe_key   text check (char_length(dedupe_key) <= 300),
  read_at      timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.notifications is
  'In-app notifications. Created only by the server-side notification service; see docs/features/notifications.md.';

create index notifications_user_created_idx on public.notifications (user_id, created_at desc, id desc);
create index notifications_user_unread_idx on public.notifications (user_id, read_at) where archived_at is null;
create index notifications_community_created_idx on public.notifications (community_id, created_at desc)
  where community_id is not null;
create unique index notifications_user_dedupe_key on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Internal helpers (never executable by clients)
-- ---------------------------------------------------------------------------
-- Active members of a community (active account) holding a permission.
-- Computes permissions for ARBITRARY users, so it must stay internal.
create or replace function private.community_members_with_permission(p_community_id uuid, p_permission_key text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.memberships m
  join public.communities c       on c.id = m.community_id and c.status = 'active'
  join public.profiles pr         on pr.id = m.user_id and pr.status = 'active'
  join public.membership_roles mr on mr.membership_id = m.id
  join public.role_permissions rp on rp.role_id = mr.role_id
  join public.permissions p       on p.id = rp.permission_id
  where m.community_id = p_community_id
    and m.status = 'active'
    and p.key = p_permission_key;
$$;

revoke all on function private.community_members_with_permission(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The notification service
-- ---------------------------------------------------------------------------
-- createNotification({ userId, communityId, type, title, body, data, dedupeKey })
-- Returns the new id, or NULL when deduplicated. Raises if the type is
-- unknown or a membership-scoped notification targets a non-member.
create or replace function private.create_notification(
  p_user_id      uuid,
  p_community_id uuid,
  p_type         text,
  p_title        text,
  p_body         text default null,
  p_data         jsonb default '{}'::jsonb,
  p_dedupe_key   text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_requires_membership boolean;
  v_id uuid;
begin
  select t.requires_membership into v_requires_membership
  from public.notification_types t where t.key = p_type;
  if v_requires_membership is null then
    raise exception 'unknown notification type: %', p_type using errcode = '22023';
  end if;

  if p_community_id is not null and v_requires_membership and not exists (
    select 1 from public.memberships m
    where m.community_id = p_community_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    raise exception 'recipient is not an active member of the community' using errcode = '22023';
  end if;

  insert into public.notifications (user_id, community_id, type, title, body, data, dedupe_key)
  values (p_user_id, p_community_id, p_type, left(btrim(p_title), 200), left(p_body, 1000),
          coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Fan-out: one notification per active member holding p_permission_key,
-- except p_exclude_user_id (usually the actor). Set-based (single INSERT).
-- p_dedupe_key is per source event; it is unique per recipient.
create or replace function private.notify_community(
  p_community_id    uuid,
  p_permission_key  text,
  p_type            text,
  p_title           text,
  p_body            text,
  p_data            jsonb,
  p_dedupe_key      text,
  p_exclude_user_id uuid default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.notification_types t where t.key = p_type) then
    raise exception 'unknown notification type: %', p_type using errcode = '22023';
  end if;

  insert into public.notifications (user_id, community_id, type, title, body, data, dedupe_key)
  select u.uid, p_community_id, p_type, left(btrim(p_title), 200), left(p_body, 1000),
         coalesce(p_data, '{}'::jsonb), p_dedupe_key
  from private.community_members_with_permission(p_community_id, p_permission_key) as u(uid)
  where u.uid is distinct from p_exclude_user_id
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.create_notification(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.notify_community(uuid, text, text, text, text, jsonb, text, uuid) from public, anon, authenticated, service_role;

-- Backend entry point (Edge Functions / workers holding the service-role
-- key). Not executable by anon or authenticated: clients can never send
-- notifications.
create or replace function public.create_notification(
  p_user_id      uuid,
  p_community_id uuid,
  p_type         text,
  p_title        text,
  p_body         text default null,
  p_data         jsonb default '{}'::jsonb,
  p_dedupe_key   text default null
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.create_notification(p_user_id, p_community_id, p_type, p_title, p_body, p_data, p_dedupe_key);
$$;

revoke all on function public.create_notification(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_notification(uuid, uuid, text, text, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Reading rules and RLS
-- ---------------------------------------------------------------------------
-- A notification is readable by its owner (live session, active account).
-- Community-scoped notifications of membership-requiring types are only
-- readable while the owner can still view that community.
create or replace function private.can_read_notification(p_user_id uuid, p_community_id uuid, p_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = (select private.current_active_user_id())
     and (
       p_community_id is null
       or not coalesce((select t.requires_membership from public.notification_types t where t.key = p_type), true)
       or public.has_community_permission(p_community_id, 'community.view')
     );
$$;

revoke all on function private.can_read_notification(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.can_read_notification(uuid, uuid, text) to authenticated;

-- Only read_at / archived_at change, and only to "now" or NULL (no
-- back-dating). Everything else is immutable.
create or replace function private.normalize_notification_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.user_id, new.community_id, new.type, new.title, new.body, new.data, new.dedupe_key, new.created_at)
     is distinct from
     (old.user_id, old.community_id, old.type, old.title, old.body, old.data, old.dedupe_key, old.created_at) then
    raise exception 'notification content is immutable' using errcode = '42501';
  end if;
  if new.read_at is not null then
    new.read_at := coalesce(old.read_at, now());
  end if;
  if new.archived_at is not null then
    new.archived_at := coalesce(old.archived_at, now());
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_notification_update() from public, anon, authenticated;

create trigger notifications_normalize_update
  before update on public.notifications
  for each row execute function private.normalize_notification_update();

revoke all on table public.notifications, public.notification_types from public, anon, authenticated;
grant all on table public.notifications, public.notification_types to service_role;
alter table public.notifications      enable row level security;
alter table public.notification_types enable row level security;

grant select on public.notification_types to authenticated;
create policy notification_types_select_all on public.notification_types
  for select to authenticated using (true);

-- No INSERT for clients, ever.
grant select on public.notifications to authenticated;
grant update (read_at, archived_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (private.can_read_notification(user_id, community_id, type));

create policy notifications_update_own on public.notifications
  for update to authenticated
  using (private.can_read_notification(user_id, community_id, type))
  with check (private.can_read_notification(user_id, community_id, type));

create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (private.can_read_notification(user_id, community_id, type));

-- ---------------------------------------------------------------------------
-- Client API (SECURITY INVOKER: RLS applies to every row)
-- ---------------------------------------------------------------------------
create or replace function public.list_my_notifications(
  p_limit             integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id         uuid default null,
  p_unread_only       boolean default false,
  p_community_id      uuid default null,
  p_include_archived  boolean default false
)
returns setof public.notifications
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
  select n.* from public.notifications n
  where n.user_id = (select private.current_active_user_id())
    and (p_include_archived or n.archived_at is null)
    and (not p_unread_only or n.read_at is null)
    and (p_community_id is null or n.community_id = p_community_id)
    and (p_cursor_id is null or (n.created_at, n.id) < (p_cursor_created_at, p_cursor_id))
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

create or replace function public.unread_notification_count(p_community_id uuid default null)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer from public.notifications n
  where n.user_id = (select private.current_active_user_id())
    and n.read_at is null
    and n.archived_at is null
    and (p_community_id is null or n.community_id = p_community_id);
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with u as (
    update public.notifications set read_at = now()
    where id = p_notification_id and read_at is null
    returning 1
  )
  select exists (select 1 from u);
$$;

create or replace function public.mark_notification_unread(p_notification_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with u as (
    update public.notifications set read_at = null
    where id = p_notification_id and read_at is not null
    returning 1
  )
  select exists (select 1 from u);
$$;

create or replace function public.mark_all_notifications_read(p_community_id uuid default null)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with u as (
    update public.notifications set read_at = now()
    where user_id = (select private.current_active_user_id())
      and read_at is null
      and (p_community_id is null or community_id = p_community_id)
    returning 1
  )
  select count(*)::integer from u;
$$;

create or replace function public.archive_notification(p_notification_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with u as (
    update public.notifications set archived_at = now(), read_at = coalesce(read_at, now())
    where id = p_notification_id and archived_at is null
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke all on function public.list_my_notifications(integer, timestamptz, uuid, boolean, uuid, boolean) from public, anon, authenticated;
revoke all on function public.unread_notification_count(uuid)    from public, anon, authenticated;
revoke all on function public.mark_notification_read(uuid)       from public, anon, authenticated;
revoke all on function public.mark_notification_unread(uuid)     from public, anon, authenticated;
revoke all on function public.mark_all_notifications_read(uuid)  from public, anon, authenticated;
revoke all on function public.archive_notification(uuid)         from public, anon, authenticated;
grant execute on function public.list_my_notifications(integer, timestamptz, uuid, boolean, uuid, boolean) to authenticated;
grant execute on function public.unread_notification_count(uuid)    to authenticated;
grant execute on function public.mark_notification_read(uuid)       to authenticated;
grant execute on function public.mark_notification_unread(uuid)     to authenticated;
grant execute on function public.mark_all_notifications_read(uuid)  to authenticated;
grant execute on function public.archive_notification(uuid)         to authenticated;

-- ---------------------------------------------------------------------------
-- Producers: other modules notify through the service
-- ---------------------------------------------------------------------------
-- All producers are AFTER triggers (same transaction as the source change)
-- and SECURITY DEFINER (recipients' rows are written on their behalf).
-- The actor is never notified about their own action.

create or replace function private.actor_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when current_setting('role', true) in ('authenticated', 'anon')
              then private.current_active_user_id() end;
$$;

revoke all on function private.actor_user_id() from public, anon, authenticated, service_role;

-- Announcements: notify members holding announcements.view on publication.
create or replace function private.notify_announcement_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    perform private.notify_community(
      new.community_id, 'announcements.view', 'announcement',
      new.title, left(new.body, 280),
      jsonb_build_object('announcement_id', new.id, 'priority', new.priority),
      'announcement:' || new.id || ':' || extract(epoch from new.published_at),
      private.actor_user_id());
  end if;
  return null;
end;
$$;

create trigger announcements_notify
  after insert or update of status on public.announcements
  for each row execute function private.notify_announcement_published();

-- Alerts: fed by the Stage 7 outbox (alert_events). In-app notifications
-- for 'published' and 'cancelled'; push/email/SMS will consume the same
-- outbox later.
create or replace function private.notify_alert_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  if new.event_type in ('published', 'cancelled') then
    select case when new.event_type = 'cancelled' then 'Withdrawn: ' || a.title else a.title end
      into v_title
    from public.alerts a where a.id = new.alert_id;
    perform private.notify_community(
      new.community_id, 'alerts.view', 'alert',
      v_title, null,
      jsonb_build_object('alert_id', new.alert_id, 'severity', new.severity, 'event', new.event_type),
      'alert:' || new.alert_id || ':' || new.event_type,
      new.actor_user_id);
  end if;
  return null;
end;
$$;

create trigger alert_events_notify
  after insert on public.alert_events
  for each row execute function private.notify_alert_event();

-- Events: publication → members with events.view; time/place change or
-- cancellation → everyone who responded going / maybe / waitlisted.
create or replace function private.notify_event_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.actor_user_id();
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    perform private.notify_community(
      new.community_id, 'events.view', 'event_created',
      new.title, null,
      jsonb_build_object('event_id', new.id, 'starts_at', new.starts_at),
      'event:' || new.id || ':created', v_actor);

  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status = 'published' then
    perform private.create_notification(
      r.user_id, new.community_id, 'event_cancelled', 'Cancelled: ' || new.title,
      new.cancellation_reason,
      jsonb_build_object('event_id', new.id),
      'event:' || new.id || ':cancelled')
    from public.event_rsvps r
    join public.memberships m on m.community_id = new.community_id and m.user_id = r.user_id and m.status = 'active'
    where r.event_id = new.id and r.status in ('going', 'maybe', 'waitlisted')
      and r.user_id is distinct from v_actor;

  elsif tg_op = 'UPDATE' and new.status = 'published'
        and (new.starts_at, new.ends_at, new.location_text) is distinct from (old.starts_at, old.ends_at, old.location_text) then
    perform private.create_notification(
      r.user_id, new.community_id, 'event_updated', 'Updated: ' || new.title, null,
      jsonb_build_object('event_id', new.id, 'reason', 'details_changed', 'starts_at', new.starts_at),
      'event:' || new.id || ':updated:' || extract(epoch from clock_timestamp()))
    from public.event_rsvps r
    join public.memberships m on m.community_id = new.community_id and m.user_id = r.user_id and m.status = 'active'
    where r.event_id = new.id and r.status in ('going', 'maybe', 'waitlisted')
      and r.user_id is distinct from v_actor;
  end if;
  return null;
end;
$$;

create trigger events_notify
  after insert or update of status, starts_at, ends_at, location_text on public.events
  for each row execute function private.notify_event_change();

-- Waitlist promotion (server-side waitlisted → going) → tell that member.
create or replace function private.notify_waitlist_promotion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'waitlisted' and new.status = 'going' then
    perform private.create_notification(
      new.user_id, new.community_id, 'event_updated',
      'You have a place: ' || e.title, null,
      jsonb_build_object('event_id', new.event_id, 'reason', 'waitlist_promoted'),
      'event:' || new.event_id || ':promoted:' || extract(epoch from clock_timestamp()))
    from public.events e where e.id = new.event_id;
  end if;
  return null;
end;
$$;

create trigger event_rsvps_notify_promotion
  after update of status on public.event_rsvps
  for each row execute function private.notify_waitlist_promotion();

-- Comments: notify the post author, and the parent comment's author for
-- replies (each once, never the commenter).
create or replace function private.notify_comment_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post_author   uuid;
  v_parent_author uuid;
begin
  select p.author_user_id into v_post_author from public.posts p where p.id = new.post_id;
  if new.parent_comment_id is not null then
    select c.author_user_id into v_parent_author from public.comments c where c.id = new.parent_comment_id;
  end if;

  if v_post_author is not null and v_post_author <> new.author_user_id
     and exists (select 1 from public.memberships m
                 where m.community_id = new.community_id and m.user_id = v_post_author and m.status = 'active') then
    perform private.create_notification(
      v_post_author, new.community_id, 'comment', 'New comment on your post', left(new.body, 280),
      jsonb_build_object('post_id', new.post_id, 'comment_id', new.id),
      'comment:' || new.id || ':post_author');
  end if;

  if v_parent_author is not null and v_parent_author <> new.author_user_id
     and v_parent_author is distinct from v_post_author
     and exists (select 1 from public.memberships m
                 where m.community_id = new.community_id and m.user_id = v_parent_author and m.status = 'active') then
    perform private.create_notification(
      v_parent_author, new.community_id, 'comment', 'New reply to your comment', left(new.body, 280),
      jsonb_build_object('post_id', new.post_id, 'comment_id', new.id, 'parent_comment_id', new.parent_comment_id),
      'comment:' || new.id || ':parent_author');
  end if;
  return null;
end;
$$;

create trigger comments_notify
  after insert on public.comments
  for each row execute function private.notify_comment_created();

-- Membership status changes → the member (approved, reinstated,
-- suspended, rejected, removed-by-status). Readable even without access to
-- the community (requires_membership = false), since it is about them.
create or replace function private.notify_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if new.status is distinct from old.status
     and new.status in ('active', 'suspended', 'rejected')
     and new.user_id is distinct from private.actor_user_id() then
    select c.name into v_name from public.communities c where c.id = new.community_id;
    perform private.create_notification(
      new.user_id, new.community_id, 'membership',
      case new.status
        when 'active'    then case when old.status = 'suspended' then 'Your membership was reinstated' else 'Welcome to ' || v_name end
        when 'suspended' then 'Your membership was suspended'
        when 'rejected'  then 'Your membership request was declined'
      end,
      v_name,
      jsonb_build_object('community_id', new.community_id, 'status', new.status, 'previous_status', old.status),
      'membership:' || new.id || ':' || new.status || ':' || extract(epoch from clock_timestamp()));
  end if;
  return null;
end;
$$;

create trigger memberships_notify
  after update of status on public.memberships
  for each row execute function private.notify_membership_change();

revoke all on function private.notify_announcement_published() from public, anon, authenticated;
revoke all on function private.notify_alert_event()            from public, anon, authenticated;
revoke all on function private.notify_event_change()           from public, anon, authenticated;
revoke all on function private.notify_waitlist_promotion()     from public, anon, authenticated;
revoke all on function private.notify_comment_created()        from public, anon, authenticated;
revoke all on function private.notify_membership_change()      from public, anon, authenticated;

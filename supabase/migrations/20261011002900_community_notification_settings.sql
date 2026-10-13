-- RN-15 / Migration 29: per-community notification preferences.
--
-- Each member chooses, per community, which kinds of in-app notification
-- they receive: announcements, events, comments and (non-urgent) alerts.
-- Defaults: everything on (no row = defaults).
--
-- Safety rule: URGENT and EMERGENCY alerts are always delivered, whatever
-- the preference; so are membership and system notifications, and personal
-- event changes (a change or cancellation of an event the member replied to,
-- or a waitlist promotion: event_updated / event_cancelled), because those
-- concern something the member actively signed up for. Only these are
-- optional:
--
--   announcements  → 'announcement'
--   events         → 'event_created'   (new events published)
--   comments       → 'comment'         (replies to your posts / comments)
--   alerts         → 'alert' with severity info or warning
--
-- Enforcement is in the database: private.create_notification() and
-- private.notify_community(), the two places every notification is created,
-- now skip recipients who turned that kind off. Clients cannot write the
-- table directly; they use set_community_notification_settings(), which
-- requires an active membership (community.view) in that community.

create table public.community_notification_settings (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  community_id  uuid not null references public.communities (id) on delete cascade,
  announcements boolean not null default true,
  events        boolean not null default true,
  comments      boolean not null default true,
  alerts        boolean not null default true,
  updated_at    timestamptz not null default now(),
  primary key (user_id, community_id)
);

comment on table public.community_notification_settings is
  'Per-community notification preferences (RN-15). Urgent and emergency alerts are always delivered. See docs/features/community-settings.md.';

create index community_notification_settings_community_idx on public.community_notification_settings (community_id);

revoke all on table public.community_notification_settings from public, anon, authenticated;
grant all on table public.community_notification_settings to service_role;
grant select on public.community_notification_settings to authenticated;
alter table public.community_notification_settings enable row level security;

create policy community_notification_settings_select_own on public.community_notification_settings
  for select to authenticated
  using (user_id = (select private.current_session_user_id()));

-- ---------------------------------------------------------------------------
-- Does this recipient want this notification? (true when no preference applies)
-- ---------------------------------------------------------------------------
create or replace function private.wants_notification(p_user_id uuid, p_community_id uuid, p_type text, p_data jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_community_id is null then true
    when p_type = 'alert' and coalesce(p_data ->> 'severity', '') in ('urgent', 'emergency') then true
    when p_type not in ('announcement', 'event_created', 'comment', 'alert') then true
    else coalesce((
      select case p_type
               when 'announcement'  then s.announcements
               when 'event_created' then s.events
               when 'comment'       then s.comments
               when 'alert'         then s.alerts
             end
      from public.community_notification_settings s
      where s.user_id = p_user_id and s.community_id = p_community_id
    ), true)
  end;
$$;

revoke all on function private.wants_notification(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The notification service, now honouring preferences (otherwise unchanged
-- from migration 15).
-- ---------------------------------------------------------------------------
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

  -- RN-15: the recipient turned this kind of notification off for this community.
  if not private.wants_notification(p_user_id, p_community_id, p_type, coalesce(p_data, '{}'::jsonb)) then
    return null;
  end if;

  insert into public.notifications (user_id, community_id, type, title, body, data, dedupe_key)
  values (p_user_id, p_community_id, p_type, left(btrim(p_title), 200), left(p_body, 1000),
          coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

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
    -- RN-15: skip members who turned this kind off for this community.
    and private.wants_notification(u.uid, p_community_id, p_type, coalesce(p_data, '{}'::jsonb))
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.create_notification(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.notify_community(uuid, text, text, text, text, jsonb, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Client API
-- ---------------------------------------------------------------------------
-- The caller's preferences for a community (defaults when never set).
create or replace function public.my_community_notification_settings(p_community_id uuid)
returns table (announcements boolean, events boolean, comments boolean, alerts boolean)
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
  if not public.has_community_permission(p_community_id, 'community.view') then
    raise exception 'not a member of this community' using errcode = '42501';
  end if;
  return query
  select coalesce(s.announcements, true), coalesce(s.events, true), coalesce(s.comments, true), coalesce(s.alerts, true)
  from (select 1) one
  left join public.community_notification_settings s on s.user_id = v_me and s.community_id = p_community_id;
end;
$$;

-- Sets the caller's preferences for a community; NULL leaves a value unchanged.
create or replace function public.set_community_notification_settings(
  p_community_id  uuid,
  p_announcements boolean default null,
  p_events        boolean default null,
  p_comments      boolean default null,
  p_alerts        boolean default null
)
returns table (announcements boolean, events boolean, comments boolean, alerts boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_active_user_id();
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.has_community_permission(p_community_id, 'community.view') then
    raise exception 'not a member of this community' using errcode = '42501';
  end if;
  insert into public.community_notification_settings as s (user_id, community_id, announcements, events, comments, alerts)
  values (v_me, p_community_id, coalesce(p_announcements, true), coalesce(p_events, true),
          coalesce(p_comments, true), coalesce(p_alerts, true))
  on conflict (user_id, community_id) do update set
    announcements = coalesce(p_announcements, s.announcements),
    events        = coalesce(p_events, s.events),
    comments      = coalesce(p_comments, s.comments),
    alerts        = coalesce(p_alerts, s.alerts),
    updated_at    = now();
  return query select * from public.my_community_notification_settings(p_community_id);
end;
$$;

revoke all on function public.my_community_notification_settings(uuid) from public, anon, authenticated;
revoke all on function public.set_community_notification_settings(uuid, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.my_community_notification_settings(uuid) to authenticated;
grant execute on function public.set_community_notification_settings(uuid, boolean, boolean, boolean, boolean) to authenticated;

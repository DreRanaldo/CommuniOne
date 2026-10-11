-- Stage 7 / Migration 13: alerts (urgent community notices)
--
-- Security-sensitive. Rules enforced here, never trusted to clients:
--   * creator, publisher and canceller identities are stamped from the
--     validated session; clients cannot write them
--   * severity is validated server-side:
--       - 'emergency' requires alerts.manage (create, publish, or set)
--       - changing severity after draft requires alerts.manage
--       - alerts.create alone allows info | warning | urgent only
--   * lifecycle transitions are fixed (see below); archived is terminal
--
-- Permissions: alerts.view (read), alerts.create (author + manage own
-- non-emergency alerts), alerts.manage (anything, including emergencies).
--
-- Lifecycle:
--   draft ──publish──► published ──cancel──► cancelled ──archive──► archived
--     │                    └──────expire──► expired   ──archive──► archived
--     └──discard (cancel)──► cancelled
-- Expiry is enforced on read (published + expires_at passed = not active)
-- and recorded by public.expire_due_alerts() (scheduler) or a manual expire.
--
-- Notification integration: every significant lifecycle change writes a row
-- to public.alert_events (transactional outbox) for a future delivery
-- worker (push / in-app / email / SMS). Nothing is delivered in this stage.

create table public.alerts (
  id                  uuid primary key default gen_random_uuid(),
  community_id        uuid not null references public.communities (id) on delete restrict,
  -- Session default, not client-writable. RESTRICT: safety records keep
  -- their accountable creator (see docs/features/alerts.md).
  created_by          uuid not null default private.current_active_user_id()
                      references public.profiles (id) on delete restrict,
  title               text not null check (char_length(btrim(title)) between 1 and 160),
  body                text not null check (char_length(btrim(body)) between 1 and 5000),
  severity            text not null default 'info'
                      check (severity in ('info', 'warning', 'urgent', 'emergency')),
  -- Derived, so clients can never disagree with the server about urgency.
  severity_rank       smallint generated always as (
                        case severity when 'info' then 1 when 'warning' then 2
                                      when 'urgent' then 3 when 'emergency' then 4 end
                      ) stored,
  is_emergency        boolean generated always as (severity = 'emergency') stored,
  status              text not null default 'draft'
                      check (status in ('draft', 'published', 'expired', 'cancelled', 'archived')),
  published_at        timestamptz,
  published_by        uuid references public.profiles (id) on delete set null,
  expires_at          timestamptz,
  expired_at          timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references public.profiles (id) on delete set null,
  cancellation_reason text check (char_length(cancellation_reason) <= 500),
  archived_at         timestamptz,
  edited_at           timestamptz,
  updated_by_user_id  uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint alerts_published_has_timestamp
    check (status in ('draft') or (status = 'cancelled' and published_at is null) or published_at is not null),
  constraint alerts_expiry_after_publication
    check (expires_at is null or published_at is null or expires_at > published_at)
);

comment on table public.alerts is 'Urgent community alerts. See docs/features/alerts.md.';

create index alerts_community_status_published_idx
  on public.alerts (community_id, status, published_at desc, id desc);
create index alerts_community_active_idx
  on public.alerts (community_id, severity_rank desc, published_at desc) where status = 'published';
-- Expiry sweep across all communities.
create index alerts_due_expiry_idx on public.alerts (expires_at) where status = 'published';
create index alerts_created_by_idx on public.alerts (created_by);

create trigger alerts_set_updated_at
  before update on public.alerts
  for each row execute function private.set_updated_at();

-- Trusted server code (service_role: the expiry sweep, future workers)
-- writes alerts, and the write triggers evaluate the caller's identity.
-- These helpers return NULL for service_role (no user session), so granting
-- them is safe; without it, service-role writes fail with "permission denied
-- for function current_active_user_id".
grant execute on function private.current_session_user_id() to service_role;
grant execute on function private.current_active_user_id()  to service_role;

-- ---------------------------------------------------------------------------
-- alert_events: transactional outbox / audit trail
-- ---------------------------------------------------------------------------
create table public.alert_events (
  id            uuid primary key default gen_random_uuid(),
  alert_id      uuid not null references public.alerts (id) on delete cascade,
  community_id  uuid not null references public.communities (id) on delete restrict,
  event_type    text not null check (event_type in ('published', 'updated', 'cancelled', 'expired')),
  -- Severity at the time of the event (drives channel selection later).
  severity      text not null check (severity in ('info', 'warning', 'urgent', 'emergency')),
  actor_user_id uuid references public.profiles (id) on delete set null,
  occurred_at   timestamptz not null default now(),
  -- For the future delivery worker: NULL = not yet dispatched.
  dispatched_at timestamptz
);

comment on table public.alert_events is
  'Outbox of alert lifecycle events for the future notification system; also an audit trail. Written only by trigger.';

create index alert_events_alert_idx on public.alert_events (alert_id, occurred_at);
create index alert_events_undispatched_idx on public.alert_events (occurred_at) where dispatched_at is null;

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
-- published / expired / cancelled / archived: alerts.view or alerts.manage
-- draft: alerts.manage, or the creator while holding alerts.create
create or replace function private.can_view_alert_row(p_community_id uuid, p_created_by uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status = 'draft' then
      public.has_community_permission(p_community_id, 'alerts.manage')
      or (p_created_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'alerts.create'))
    else
      public.has_community_permission(p_community_id, 'alerts.view')
      or public.has_community_permission(p_community_id, 'alerts.manage')
  end;
$$;

create or replace function private.can_manage_alert_row(p_community_id uuid, p_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_community_permission(p_community_id, 'alerts.manage')
      or (p_created_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'alerts.create'));
$$;

revoke all on function private.can_view_alert_row(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.can_manage_alert_row(uuid, uuid)     from public, anon, authenticated;
grant execute on function private.can_view_alert_row(uuid, uuid, text) to authenticated;
grant execute on function private.can_manage_alert_row(uuid, uuid)     to authenticated;

-- ---------------------------------------------------------------------------
-- Write enforcement (who may act: RLS; what may change: this trigger)
-- ---------------------------------------------------------------------------
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
     or new.created_by is distinct from old.created_by
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

revoke all on function private.enforce_alert_write() from public, anon, authenticated;

create trigger alerts_enforce_write
  before insert or update on public.alerts
  for each row execute function private.enforce_alert_write();

-- Outbox writer. SECURITY DEFINER: clients have no privileges on
-- alert_events. Reads only the alert row being written.
create or replace function private.record_alert_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event       text;
  v_client_role boolean := current_setting('role', true) in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    v_event := case when new.status = 'published' then 'published' end;
  elsif new.status is distinct from old.status then
    v_event := case new.status
      when 'published' then 'published'
      when 'cancelled' then case when old.status = 'published' then 'cancelled' end
      when 'expired'   then 'expired'
    end;
  elsif new.status = 'published'
        and ((new.title, new.body, new.severity) is distinct from (old.title, old.body, old.severity)
             or new.expires_at is distinct from old.expires_at) then
    v_event := 'updated';
  end if;

  if v_event is not null then
    -- Actor is recorded for client requests only (NULL = system, e.g. the
    -- expiry sweep). SECURITY DEFINER changes current_user, so the request's
    -- role is read from the 'role' setting (what PostgREST / SET ROLE chose).
    insert into public.alert_events (alert_id, community_id, event_type, severity, actor_user_id)
    values (new.id, new.community_id, v_event, new.severity,
            case when v_client_role then private.current_active_user_id() end);
  end if;
  return null;
end;
$$;

revoke all on function private.record_alert_event() from public, anon, authenticated;

create trigger alerts_record_event
  after insert or update on public.alerts
  for each row execute function private.record_alert_event();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.alerts, public.alert_events from public, anon, authenticated;
grant all on table public.alerts, public.alert_events to service_role;
alter table public.alerts       enable row level security;
alter table public.alert_events enable row level security;

grant select on public.alerts to authenticated;
grant insert (community_id, title, body, severity, status, expires_at) on public.alerts to authenticated;
grant update (title, body, severity, status, expires_at, cancellation_reason) on public.alerts to authenticated;
-- No DELETE: alerts are safety records.

create policy alerts_select_visible on public.alerts
  for select to authenticated
  using (private.can_view_alert_row(community_id, created_by, status));

create policy alerts_insert_authorized on public.alerts
  for insert to authenticated
  with check (
    created_by = (select private.current_active_user_id())
    and status in ('draft', 'published')
    and public.has_community_permission(community_id, 'alerts.create')
    and (severity <> 'emergency' or public.has_community_permission(community_id, 'alerts.manage'))
  );

create policy alerts_update_authorized on public.alerts
  for update to authenticated
  using (private.can_manage_alert_row(community_id, created_by))
  with check (private.can_manage_alert_row(community_id, created_by));

-- alert_events: read-only audit for managers; written only by trigger.
grant select on public.alert_events to authenticated;

create policy alert_events_select_managers on public.alert_events
  for select to authenticated
  using (public.has_community_permission(community_id, 'alerts.manage'));

-- ---------------------------------------------------------------------------
-- Expiry sweep (for a scheduler such as pg_cron or an Edge Function)
-- ---------------------------------------------------------------------------
-- Marks published alerts whose expires_at has passed as 'expired' and
-- records an 'expired' event for each. Service role only. Reads never depend
-- on it having run.
create or replace function public.expire_due_alerts()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with expired as (
    update public.alerts
    set status = 'expired', expired_at = now()
    where status = 'published' and expires_at is not null and expires_at <= now()
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke all on function public.expire_due_alerts() from public, anon, authenticated;
grant execute on function public.expire_due_alerts() to service_role;

-- ---------------------------------------------------------------------------
-- Read API (SECURITY INVOKER: RLS filters every row)
-- ---------------------------------------------------------------------------
-- Active alerts of one community: published and not expired. Emergencies
-- first (severity_rank), then newest. Keyset cursor = last row's
-- (severity_rank, published_at, id).
create or replace function public.list_active_alerts(
  p_community_id         uuid,
  p_limit                integer default 20,
  p_cursor_severity_rank smallint default null,
  p_cursor_published_at  timestamptz default null,
  p_cursor_id            uuid default null
)
returns table (
  id            uuid,
  community_id  uuid,
  title         text,
  body          text,
  severity      text,
  severity_rank smallint,
  is_emergency  boolean,
  published_at  timestamptz,
  published_by  uuid,
  expires_at    timestamptz,
  edited_at     timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if num_nulls(p_cursor_severity_rank, p_cursor_published_at, p_cursor_id) not in (0, 3) then
    raise exception 'cursor requires p_cursor_severity_rank, p_cursor_published_at and p_cursor_id' using errcode = '22023';
  end if;

  return query
  select a.id, a.community_id, a.title, a.body, a.severity, a.severity_rank, a.is_emergency,
         a.published_at, a.published_by, a.expires_at, a.edited_at
  from public.alerts a
  where a.community_id = p_community_id
    and a.status = 'published'
    and (a.expires_at is null or a.expires_at > now())
    and (p_cursor_id is null
         or (a.severity_rank, a.published_at, a.id) < (p_cursor_severity_rank, p_cursor_published_at, p_cursor_id))
  order by a.severity_rank desc, a.published_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- Active alerts across every community the caller belongs to (app-wide
-- banner). Emergencies first. Capped at 50.
create or replace function public.list_my_active_alerts()
returns table (
  id            uuid,
  community_id  uuid,
  title         text,
  severity      text,
  severity_rank smallint,
  is_emergency  boolean,
  published_at  timestamptz,
  expires_at    timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select a.id, a.community_id, a.title, a.severity, a.severity_rank, a.is_emergency, a.published_at, a.expires_at
  from public.alerts a
  where a.status = 'published'
    and (a.expires_at is null or a.expires_at > now())
    and a.community_id in (
      select m.community_id from public.memberships m
      where m.user_id = (select private.current_active_user_id()) and m.status = 'active'
    )
  order by a.severity_rank desc, a.published_at desc, a.id desc
  limit 50;
$$;

-- History: everything visible except drafts by default, newest first.
create or replace function public.list_alert_history(
  p_community_id   uuid,
  p_limit          integer default 20,
  p_cursor_sort_at timestamptz default null,
  p_cursor_id      uuid default null,
  p_statuses       text[] default array['published', 'expired', 'cancelled', 'archived']
)
returns table (
  id                  uuid,
  community_id        uuid,
  title               text,
  body                text,
  severity            text,
  severity_rank       smallint,
  is_emergency        boolean,
  status              text,
  is_active           boolean,
  published_at        timestamptz,
  expires_at          timestamptz,
  expired_at          timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  archived_at         timestamptz,
  sort_at             timestamptz
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
  select a.id, a.community_id, a.title, a.body, a.severity, a.severity_rank, a.is_emergency, a.status,
         (a.status = 'published' and (a.expires_at is null or a.expires_at > now())),
         a.published_at, a.expires_at, a.expired_at, a.cancelled_at, a.cancellation_reason, a.archived_at,
         coalesce(a.published_at, a.created_at)
  from public.alerts a
  where a.community_id = p_community_id
    and a.status = any (coalesce(p_statuses, array['published', 'expired', 'cancelled', 'archived']))
    and (p_cursor_id is null
         or (coalesce(a.published_at, a.created_at), a.id) < (p_cursor_sort_at, p_cursor_id))
  order by coalesce(a.published_at, a.created_at) desc, a.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

revoke all on function public.list_active_alerts(uuid, integer, smallint, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.list_my_active_alerts()                                         from public, anon, authenticated;
revoke all on function public.list_alert_history(uuid, integer, timestamptz, uuid, text[])   from public, anon, authenticated;
grant execute on function public.list_active_alerts(uuid, integer, smallint, timestamptz, uuid) to authenticated;
grant execute on function public.list_my_active_alerts()                                         to authenticated;
grant execute on function public.list_alert_history(uuid, integer, timestamptz, uuid, text[])   to authenticated;

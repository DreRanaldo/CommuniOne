-- Stage 8 / Migration 14: events and RSVPs
--
-- Permissions: events.view (read + RSVP), events.create (create + manage
-- own), events.manage (any event in the community).
--
-- Event lifecycle:
--   draft ──publish──► published ──complete──► completed (terminal)
--     │                    └──cancel──► cancelled (terminal)
--     └──discard (cancel)──► cancelled
--
-- RSVP lifecycle (per user per event, UNIQUE(event_id, user_id)):
--   going | maybe | not_going chosen by the user; 'waitlisted' is assigned
--   ONLY by the server when the event is full. Deleting the RSVP cancels it.
--   RSVPs can be created/changed/cancelled while the event is published and
--   has not started.
--
-- CAPACITY AND CONCURRENCY
--   Every RSVP write (client or server) passes through
--   private.apply_rsvp_capacity(), which first UPDATEs the event row. That
--   row lock serialises all RSVP writes for the same event:
--     * READ COMMITTED (PostgREST default): concurrent writers wait, then
--       count with a fresh snapshot that includes the winner's row.
--     * REPEATABLE READ / SERIALIZABLE: a concurrent writer gets a
--       serialization failure instead of counting a stale snapshot.
--   Only then is the number of 'going' RSVPs counted; if the event is full
--   the request becomes 'waitlisted'. Freed places are given to the
--   waitlist in FIFO order (waitlisted_at, id) within the same transaction.
--   There is no count-then-insert race: the count happens under the lock.

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table public.events (
  id                  uuid primary key default gen_random_uuid(),
  community_id        uuid not null references public.communities (id) on delete restrict,
  -- Session default, not client-writable. RESTRICT: same accountability
  -- decision as alerts.created_by (see docs/features/events.md).
  created_by          uuid not null default private.current_active_user_id()
                      references public.profiles (id) on delete restrict,
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  description         text check (char_length(description) <= 10000),
  location_text       text check (char_length(location_text) <= 500),
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  timezone            text not null default 'UTC',
  capacity            integer check (capacity between 1 and 100000),
  status              text not null default 'draft'
                      check (status in ('draft', 'published', 'cancelled', 'completed')),
  published_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references public.profiles (id) on delete set null,
  cancellation_reason text check (char_length(cancellation_reason) <= 500),
  completed_at        timestamptz,
  edited_at           timestamptz,
  updated_by_user_id  uuid references public.profiles (id) on delete set null,
  -- Bumped under lock by every RSVP write (see header). Not client-writable.
  -- Note: because RSVP writes lock the event with an UPDATE, updated_at also
  -- moves on RSVP activity; use edited_at for "event details changed".
  rsvp_changed_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint events_ends_after_start check (ends_at >= starts_at),
  constraint events_id_community_key unique (id, community_id)
);

comment on table public.events is 'Community events. See docs/features/events.md.';

create index events_community_starts_idx on public.events (community_id, starts_at, id);
create index events_community_status_starts_idx on public.events (community_id, status, starts_at);
create index events_created_by_idx on public.events (created_by);

create trigger events_set_updated_at
  before update on public.events
  for each row execute function private.set_updated_at();

-- Reuse the IANA timezone validator from communities (it checks new.timezone).
create trigger events_validate_timezone
  before insert or update of timezone on public.events
  for each row execute function private.validate_community_timezone();

-- ---------------------------------------------------------------------------
-- event_rsvps
-- ---------------------------------------------------------------------------
create table public.event_rsvps (
  id            uuid primary key default gen_random_uuid(),
  -- Derived from the event by trigger; never supplied by clients.
  community_id  uuid not null,
  event_id      uuid not null,
  user_id       uuid not null default private.current_active_user_id()
                references public.profiles (id) on delete cascade,
  status        text not null check (status in ('going', 'maybe', 'not_going', 'waitlisted')),
  -- Server-maintained queue position; set while waitlisted.
  waitlisted_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint event_rsvps_event_user_key unique (event_id, user_id),
  constraint event_rsvps_event_fk
    foreign key (event_id, community_id)
    references public.events (id, community_id) on delete cascade,
  constraint event_rsvps_waitlist_position
    check ((status = 'waitlisted') = (waitlisted_at is not null))
);

comment on table public.event_rsvps is
  'One RSVP per user per event. waitlisted is server-assigned when the event is full.';

-- RSVPs by event are served by event_rsvps_event_user_key (leading column).
create index event_rsvps_waitlist_idx on public.event_rsvps (event_id, waitlisted_at, id) where status = 'waitlisted';
create index event_rsvps_going_idx on public.event_rsvps (event_id) where status = 'going';
create index event_rsvps_user_idx on public.event_rsvps (user_id);

create trigger event_rsvps_set_updated_at
  before update on public.event_rsvps
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Visibility / authorization helpers
-- ---------------------------------------------------------------------------
-- published / cancelled / completed: events.view or events.manage
-- draft: events.manage, or the creator while holding events.create
create or replace function private.can_view_event_row(p_community_id uuid, p_created_by uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status = 'draft' then
      public.has_community_permission(p_community_id, 'events.manage')
      or (p_created_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'events.create'))
    else
      public.has_community_permission(p_community_id, 'events.view')
      or public.has_community_permission(p_community_id, 'events.manage')
  end;
$$;

create or replace function private.can_view_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.can_view_event_row(e.community_id, e.created_by, e.status)
    from public.events e where e.id = p_event_id
  ), false);
$$;

create or replace function private.can_manage_event_row(p_community_id uuid, p_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_community_permission(p_community_id, 'events.manage')
      or (p_created_by = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'events.create'));
$$;

-- RSVPs are open while the event is published and has not started, to
-- members holding events.view.
create or replace function private.can_rsvp(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event_id
      and e.status = 'published'
      and e.starts_at > now()
      and public.has_community_permission(e.community_id, 'events.view')
  );
$$;

revoke all on function private.can_view_event_row(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.can_view_event(uuid)                 from public, anon, authenticated;
revoke all on function private.can_manage_event_row(uuid, uuid)     from public, anon, authenticated;
revoke all on function private.can_rsvp(uuid)                       from public, anon, authenticated;
grant execute on function private.can_view_event_row(uuid, uuid, text) to authenticated;
grant execute on function private.can_view_event(uuid)                 to authenticated;
grant execute on function private.can_manage_event_row(uuid, uuid)     to authenticated;
grant execute on function private.can_rsvp(uuid)                       to authenticated;

-- ---------------------------------------------------------------------------
-- Waitlist promotion
-- ---------------------------------------------------------------------------
-- Fills free 'going' places from the waitlist, oldest first. Must be called
-- while holding the event row lock (all callers below do). Promoted rows go
-- through apply_rsvp_capacity() again, which re-checks under the same lock.
create or replace function private.promote_waitlist(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_going    integer;
  v_free     integer;
  v_promoted integer := 0;
begin
  select e.capacity into v_capacity from public.events e where e.id = p_event_id;

  if v_capacity is null then
    v_free := 2147483647;
  else
    select count(*) into v_going from public.event_rsvps r where r.event_id = p_event_id and r.status = 'going';
    v_free := v_capacity - v_going;
  end if;

  if v_free > 0 then
    with next_in_line as (
      select r.id from public.event_rsvps r
      where r.event_id = p_event_id and r.status = 'waitlisted'
      order by r.waitlisted_at, r.id
      limit v_free
    )
    update public.event_rsvps r set status = 'going'
    from next_in_line n where r.id = n.id;
    get diagnostics v_promoted = row_count;
  end if;

  return v_promoted;
end;
$$;

revoke all on function private.promote_waitlist(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RSVP write enforcement (capacity, waitlist, immutability)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: must lock (UPDATE) the event row and count every RSVP
-- for the event, neither of which the RSVPing member may do directly.
create or replace function private.apply_rsvp_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity     integer;
  v_community_id uuid;
  v_going        integer;
begin
  if tg_op = 'UPDATE' and (new.event_id is distinct from old.event_id
                           or new.user_id is distinct from old.user_id
                           or new.community_id is distinct from old.community_id) then
    raise exception 'RSVP event and user are immutable' using errcode = '42501';
  end if;

  -- Serialise all RSVP writes for this event (see header).
  update public.events e set rsvp_changed_at = clock_timestamp()
  where e.id = new.event_id
  returning e.capacity, e.community_id into v_capacity, v_community_id;

  if v_community_id is null then
    raise exception 'event not found' using errcode = '23503';
  end if;
  new.community_id := v_community_id;

  -- 'waitlisted' is never a client choice; a request for it is a request
  -- to attend.
  if new.status = 'waitlisted' and (tg_op = 'INSERT' or old.status <> 'waitlisted') then
    new.status := 'going';
  end if;

  if new.status = 'going' and (tg_op = 'INSERT' or old.status <> 'going') then
    if v_capacity is not null then
      select count(*) into v_going
      from public.event_rsvps r
      where r.event_id = new.event_id and r.status = 'going' and r.id <> new.id;
      if v_going >= v_capacity then
        new.status := 'waitlisted';
      end if;
    end if;
  end if;

  -- Keep the queue position while waiting; clear it otherwise.
  if new.status = 'waitlisted' then
    new.waitlisted_at := case
      when tg_op = 'UPDATE' and old.status = 'waitlisted' then old.waitlisted_at
      else clock_timestamp()
    end;
  else
    new.waitlisted_at := null;
  end if;

  return new;
end;
$$;

revoke all on function private.apply_rsvp_capacity() from public, anon, authenticated;

create trigger event_rsvps_apply_capacity
  before insert or update on public.event_rsvps
  for each row execute function private.apply_rsvp_capacity();

-- A 'going' place freed by a change or cancellation goes to the waitlist.
create or replace function private.release_rsvp_place()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'going' and (tg_op = 'DELETE' or new.status <> 'going') then
    -- Lock the event (already held for UPDATE via the BEFORE trigger; taken
    -- here for DELETE), then promote.
    update public.events e set rsvp_changed_at = clock_timestamp() where e.id = old.event_id;
    perform private.promote_waitlist(old.event_id);
  end if;
  return null;
end;
$$;

revoke all on function private.release_rsvp_place() from public, anon, authenticated;

create trigger event_rsvps_release_place
  after update or delete on public.event_rsvps
  for each row execute function private.release_rsvp_place();

-- ---------------------------------------------------------------------------
-- Event write enforcement
-- ---------------------------------------------------------------------------
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
     or new.created_by is distinct from old.created_by
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

revoke all on function private.enforce_event_write() from public, anon, authenticated;

create trigger events_enforce_write
  before insert or update on public.events
  for each row execute function private.enforce_event_write();

-- More places (or unlimited) → promote from the waitlist.
create or replace function private.on_event_capacity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.capacity is distinct from old.capacity
     and (new.capacity is null or (old.capacity is not null and new.capacity > old.capacity)) then
    perform private.promote_waitlist(new.id);
  end if;
  return null;
end;
$$;

revoke all on function private.on_event_capacity_change() from public, anon, authenticated;

create trigger events_capacity_change
  after update of capacity on public.events
  for each row execute function private.on_event_capacity_change();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.events, public.event_rsvps from public, anon, authenticated;
grant all on table public.events, public.event_rsvps to service_role;
alter table public.events      enable row level security;
alter table public.event_rsvps enable row level security;

grant select on public.events to authenticated;
grant insert (community_id, title, description, location_text, starts_at, ends_at, timezone, capacity, status)
  on public.events to authenticated;
grant update (title, description, location_text, starts_at, ends_at, timezone, capacity, status, cancellation_reason)
  on public.events to authenticated;
-- No DELETE: cancel instead.

create policy events_select_visible on public.events
  for select to authenticated
  using (private.can_view_event_row(community_id, created_by, status));

create policy events_insert_authorized on public.events
  for insert to authenticated
  with check (
    created_by = (select private.current_active_user_id())
    and status in ('draft', 'published')
    and public.has_community_permission(community_id, 'events.create')
  );

create policy events_update_authorized on public.events
  for update to authenticated
  using (private.can_manage_event_row(community_id, created_by))
  with check (private.can_manage_event_row(community_id, created_by));

-- RSVPs: users write only their own; status is sanitised by the trigger.
grant select on public.event_rsvps to authenticated;
grant insert (event_id, status) on public.event_rsvps to authenticated;
grant update (status) on public.event_rsvps to authenticated;
grant delete on public.event_rsvps to authenticated;

-- Own RSVPs; 'going' RSVPs of visible events (attendee list); every RSVP
-- for event managers.
create policy event_rsvps_select_visible on public.event_rsvps
  for select to authenticated
  using (
    user_id = (select private.current_active_user_id())
    or (status = 'going' and private.can_view_event(event_id))
    or public.has_community_permission(community_id, 'events.manage')
  );

create policy event_rsvps_insert_own on public.event_rsvps
  for insert to authenticated
  with check (user_id = (select private.current_active_user_id()) and private.can_rsvp(event_id));

create policy event_rsvps_update_own on public.event_rsvps
  for update to authenticated
  using (user_id = (select private.current_active_user_id()) and private.can_rsvp(event_id))
  with check (user_id = (select private.current_active_user_id()) and private.can_rsvp(event_id));

create policy event_rsvps_delete_own on public.event_rsvps
  for delete to authenticated
  using (user_id = (select private.current_active_user_id()) and private.can_rsvp(event_id));

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------
-- Lock ordering. The capacity trigger locks the event row, but an upsert
-- or delete has already locked the member's RSVP row by then, while waitlist
-- promotion holds the event lock and then locks RSVP rows. Under heavy
-- contention that opposite ordering can deadlock (Postgres aborts one side;
-- capacity is never violated, but the client sees a retryable error).
-- The RPCs below take the event lock FIRST, so they never deadlock with
-- each other. Locking is a no-op unless the caller may RSVP to the event.
create or replace function private.lock_event_for_rsvp(p_event_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.events e set rsvp_changed_at = clock_timestamp()
  where e.id = p_event_id and private.can_rsvp(p_event_id);
$$;

revoke all on function private.lock_event_for_rsvp(uuid) from public, anon, authenticated;
grant execute on function private.lock_event_for_rsvp(uuid) to authenticated;

-- RSVP or change RSVP in one call. SECURITY INVOKER: RLS and the capacity
-- trigger apply. Returns the stored status ('waitlisted' if the event is full).
create or replace function public.rsvp_to_event(p_event_id uuid, p_status text)
returns table (event_id uuid, status text, waitlisted_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('going', 'maybe', 'not_going') then
    raise exception 'status must be going, maybe or not_going' using errcode = '22023';
  end if;

  perform private.lock_event_for_rsvp(p_event_id);

  return query
  insert into public.event_rsvps as r (event_id, status)
  values (p_event_id, p_status)
  on conflict on constraint event_rsvps_event_user_key
  do update set status = excluded.status
  returning r.event_id, r.status, r.waitlisted_at;
end;
$$;

-- Cancel your RSVP (frees your place; the waitlist is promoted). Returns
-- true if an RSVP was removed. SECURITY INVOKER: RLS applies.
create or replace function public.cancel_rsvp(p_event_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  perform private.lock_event_for_rsvp(p_event_id);
  delete from public.event_rsvps r
  where r.event_id = p_event_id and r.user_id = (select private.current_active_user_id());
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- Attendance for one event: counts are visible to anyone who can see the
-- event (SECURITY DEFINER so members get correct totals without seeing
-- other people's maybe / not-going answers). Returns no row otherwise.
create or replace function public.get_event_attendance(p_event_id uuid)
returns table (
  event_id          uuid,
  capacity          integer,
  going_count       integer,
  maybe_count       integer,
  not_going_count   integer,
  waitlisted_count  integer,
  spots_left        integer,
  my_status         text,
  my_waitlist_position integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with ev as (
    select e.id, e.capacity
    from public.events e
    where e.id = p_event_id
      and private.can_view_event_row(e.community_id, e.created_by, e.status)
  ),
  counts as (
    select
      count(*) filter (where r.status = 'going')::integer      as going,
      count(*) filter (where r.status = 'maybe')::integer      as maybe,
      count(*) filter (where r.status = 'not_going')::integer  as not_going,
      count(*) filter (where r.status = 'waitlisted')::integer as waitlisted
    from public.event_rsvps r
    where r.event_id = p_event_id
  ),
  me as (
    select r.id, r.status, r.waitlisted_at
    from public.event_rsvps r
    where r.event_id = p_event_id
      and r.user_id = (select private.current_active_user_id())
  )
  select
    ev.id,
    ev.capacity,
    counts.going,
    counts.maybe,
    counts.not_going,
    counts.waitlisted,
    case when ev.capacity is null then null else greatest(ev.capacity - counts.going, 0) end,
    me.status,
    case when me.status = 'waitlisted' then (
      select count(*)::integer + 1
      from public.event_rsvps w
      where w.event_id = p_event_id and w.status = 'waitlisted'
        and (w.waitlisted_at, w.id) < (me.waitlisted_at, me.id)
    ) end
  from ev
  cross join counts
  left join me on true;
$$;

-- Upcoming published events (not yet ended), soonest first, keyset on
-- (starts_at, id).
create or replace function public.list_upcoming_events(
  p_community_id      uuid,
  p_limit             integer default 20,
  p_cursor_starts_at  timestamptz default null,
  p_cursor_id         uuid default null
)
returns setof public.events
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_starts_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_starts_at and p_cursor_id' using errcode = '22023';
  end if;
  return query
  select e.* from public.events e
  where e.community_id = p_community_id
    and e.status = 'published'
    and e.ends_at > now()
    and (p_cursor_id is null or (e.starts_at, e.id) > (p_cursor_starts_at, p_cursor_id))
  order by e.starts_at, e.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- Any events in a time window and set of statuses (calendar / history),
-- in start order. Managers may include 'draft'.
create or replace function public.list_events(
  p_community_id     uuid,
  p_from             timestamptz default null,
  p_to               timestamptz default null,
  p_statuses         text[] default array['published', 'cancelled', 'completed'],
  p_limit            integer default 20,
  p_cursor_starts_at timestamptz default null,
  p_cursor_id        uuid default null
)
returns setof public.events
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_starts_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_starts_at and p_cursor_id' using errcode = '22023';
  end if;
  return query
  select e.* from public.events e
  where e.community_id = p_community_id
    and e.status = any (coalesce(p_statuses, array['published', 'cancelled', 'completed']))
    and (p_from is null or e.ends_at >= p_from)
    and (p_to is null or e.starts_at < p_to)
    and (p_cursor_id is null or (e.starts_at, e.id) > (p_cursor_starts_at, p_cursor_id))
  order by e.starts_at, e.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

revoke all on function public.rsvp_to_event(uuid, text)                                                   from public, anon, authenticated;
revoke all on function public.cancel_rsvp(uuid)                                                           from public, anon, authenticated;
grant execute on function public.cancel_rsvp(uuid)                                                           to authenticated;
revoke all on function public.get_event_attendance(uuid)                                                  from public, anon, authenticated;
revoke all on function public.list_upcoming_events(uuid, integer, timestamptz, uuid)                       from public, anon, authenticated;
revoke all on function public.list_events(uuid, timestamptz, timestamptz, text[], integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.rsvp_to_event(uuid, text)                                                   to authenticated;
grant execute on function public.get_event_attendance(uuid)                                                  to authenticated;
grant execute on function public.list_upcoming_events(uuid, integer, timestamptz, uuid)                       to authenticated;
grant execute on function public.list_events(uuid, timestamptz, timestamptz, text[], integer, timestamptz, uuid) to authenticated;

-- Stage 12 / Migration 22: service-layer hardening (index + RSVP existence oracle)
--
-- Query review for the Stage 12 service layer (docs/architecture/service-layer.md):
-- every list operation is keyset-paginated and served by an index, except
-- the member list, which pages memberships by (created_at, id) within a
-- community and status. memberships_community_status_idx finds the rows
-- but then sorts them; this index serves the filter, the order and the
-- cursor directly.
create index memberships_community_status_created_idx
  on public.memberships (community_id, status, created_at, id);

-- The new index makes the (community_id, status) index redundant (it is a
-- prefix of this one).
drop index public.memberships_community_status_idx;

-- ---------------------------------------------------------------------------
-- IDOR review: RSVPing to an event id from another community failed with
-- "permission denied", but an id that does not exist failed with "event not
-- found" (23503), and the capacity trigger locked the foreign event row
-- before RLS refused the insert. apply_rsvp_capacity() now refuses every
-- such case up front with the same 42501 answer. Unchanged otherwise
-- (definition from migration 14 plus the marked block).
-- ---------------------------------------------------------------------------
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

  -- A new RSVP from a client must be for an event the caller may RSVP to.
  -- Checked before the event row is touched, and with one answer for an
  -- event that does not exist, belongs to another community, or is closed,
  -- so the error reveals nothing about other communities' events.
  if tg_op = 'INSERT' and private.actor_user_id() is not null and not private.can_rsvp(new.event_id) then
    raise exception 'you cannot RSVP to this event' using errcode = '42501';
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

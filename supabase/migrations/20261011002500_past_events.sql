-- RN-11 / Migration 25: past events, newest first.
--
-- list_events() pages in start order (oldest first), which suits a calendar
-- window but not a "Past events" list: a long-lived community would page
-- through years of history before reaching last week. list_past_events()
-- returns the events that are over, most recent first, with a keyset cursor
-- on (starts_at, id) descending.
--
-- "Over" means: completed (an organizer closed it, possibly before its end
-- time), or published / cancelled with an end time that has passed.
-- Upcoming cancelled events are not past: the app lists them with the
-- upcoming ones (list_events from now), marked cancelled. Drafts are never
-- past events.
--
-- SECURITY INVOKER: the events RLS policies decide which rows each caller
-- receives (events.view / events.manage in that community), exactly as for
-- list_events(). No new privilege, table or policy.

create or replace function public.list_past_events(
  p_community_id     uuid,
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
    and (e.status = 'completed' or (e.status in ('published', 'cancelled') and e.ends_at <= now()))
    and (p_cursor_id is null or (e.starts_at, e.id) < (p_cursor_starts_at, p_cursor_id))
  order by e.starts_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

comment on function public.list_past_events(uuid, integer, timestamptz, uuid) is
  'Events that are over (completed, or published/cancelled and ended), newest first. RLS applies.';

revoke all on function public.list_past_events(uuid, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_past_events(uuid, integer, timestamptz, uuid) to authenticated;

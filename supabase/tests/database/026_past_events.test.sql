-- RN-11: list_past_events(): what is over, newest first, keyset paging, RLS isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(9);

-- ---------------------------------------------------------------------------
-- Fixture (identical in every behavioural test file)
--
--   Community A (community-a)            Community B (community-b)
--     alice  Owner  (creator)              bob    Owner  (creator)
--     erin   Admin                         frank  Member
--     dave   Moderator                     alice  Member  <- multi-community
--     carol  Member
--     grace  pending, no role
--
-- Communities are created through public.create_community() as the real
-- users. Other memberships are inserted as a trusted backend would (the
-- Stage 2 invitation / join flows), because clients cannot insert them.
-- ---------------------------------------------------------------------------
-- Impersonates a signed-in user exactly as PostgREST does: role
-- `authenticated` plus verified JWT claims. Every fixture user has a live
-- auth.sessions row whose id equals the user id (see below).
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_user, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create temp table fx (key text primary key, id uuid not null);
grant all on fx to public;

create function pg_temp.fx(p_key text) returns uuid language sql stable as $$
  select id from fx where key = p_key
$$;

create function pg_temp.role_id(p_community text, p_role text) returns uuid language sql stable as $$
  select r.id from public.roles r where r.community_id = pg_temp.fx(p_community) and r.name = p_role
$$;

create function pg_temp.add_member(p_community text, p_user text, p_role text, p_status text default 'active')
returns void language plpgsql as $$
declare v_membership_id uuid;
begin
  insert into public.memberships (community_id, user_id, status)
  values (pg_temp.fx(p_community), pg_temp.fx(p_user), p_status)
  returning id into v_membership_id;
  insert into fx values (p_user || '@' || p_community, v_membership_id);
  if p_role is not null then
    insert into public.membership_roles (membership_id, role_id)
    values (v_membership_id, pg_temp.role_id(p_community, p_role));
  end if;
end;
$$;

insert into fx values
  ('alice', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('bob',   'bbbbbbbb-0000-4000-8000-000000000002'),
  ('carol', 'cccccccc-0000-4000-8000-000000000003'),
  ('dave',  'dddddddd-0000-4000-8000-000000000004'),
  ('erin',  'eeeeeeee-0000-4000-8000-000000000005'),
  ('frank', 'ffffffff-0000-4000-8000-000000000006'),
  ('grace', '99999999-0000-4000-8000-000000000007');

insert into auth.users (id, email)
select id, key || '@example.test' from fx;
insert into auth.sessions (id, user_id)
select id, id from fx;

select pg_temp.login(pg_temp.fx('alice'));
insert into fx select 'A', id from public.create_community('Community A', 'community-a', 'residential');
select pg_temp.login(pg_temp.fx('bob'));
insert into fx select 'B', id from public.create_community('Community B', 'community-b', 'church');
reset role;

insert into fx select 'alice@A', id from public.memberships where community_id = pg_temp.fx('A') and user_id = pg_temp.fx('alice');
insert into fx select 'bob@B',   id from public.memberships where community_id = pg_temp.fx('B') and user_id = pg_temp.fx('bob');

select pg_temp.add_member('A', 'erin',  'Admin');
select pg_temp.add_member('A', 'dave',  'Moderator');
select pg_temp.add_member('A', 'carol', 'Member');
select pg_temp.add_member('A', 'grace', null, 'pending');
select pg_temp.add_member('B', 'frank', 'Member');
select pg_temp.add_member('B', 'alice', 'Member');
-- ---------------------------------------------------------------------------

-- Events in both communities, written as the database owner (trusted
-- server code: past dates are allowed, nothing is stamped by the client).
create function pg_temp.event_at(p_key text, p_community text, p_status text, p_starts interval, p_hours integer default 2)
returns void language sql as $$
  with e as (
    insert into public.events (community_id, title, starts_at, ends_at, status, created_by)
    values (pg_temp.fx(p_community), p_key, now() + p_starts, now() + p_starts + make_interval(hours => p_hours),
            'draft', pg_temp.fx(case when p_community = 'A' then 'alice' else 'bob' end))
    returning id
  )
  insert into fx select p_key, id from e;
  -- Then the status, as trusted server code (the client lifecycle rules do not apply).
  update public.events set status = p_status where id = pg_temp.fx(p_key);
$$;
select pg_temp.event_at('past_recent',    'A', 'published', interval '-1 day');
select pg_temp.event_at('past_old',       'A', 'published', interval '-30 days');
select pg_temp.event_at('past_cancelled', 'A', 'cancelled', interval '-3 days');
select pg_temp.event_at('completed_early','A', 'completed', interval '-1 hour', 5);  -- completed, end time still ahead
select pg_temp.event_at('in_progress',    'A', 'published', interval '-1 hour', 5);  -- started, not ended: not past
select pg_temp.event_at('future',         'A', 'published', interval '2 days');
select pg_temp.event_at('future_cancel',  'A', 'cancelled', interval '3 days');
select pg_temp.event_at('past_draft',     'A', 'draft',     interval '-2 days');
select pg_temp.event_at('b_past',         'B', 'published', interval '-1 day');

create function pg_temp.past_titles(p_community text, p_limit integer default 20,
                                    p_cursor_starts_at timestamptz default null, p_cursor_id uuid default null)
returns text[] language sql as $$
  select coalesce(array_agg(title), '{}') from (
    select title from public.list_past_events(pg_temp.fx(p_community), p_limit, p_cursor_starts_at, p_cursor_id)
  ) t
$$;

-- 1. Members see what is over, newest first.
select pg_temp.login(pg_temp.fx('carol'));
select is(
  pg_temp.past_titles('A'),
  array['completed_early', 'past_recent', 'past_cancelled', 'past_old'],
  '1. completed, ended and ended-cancelled events, newest first; no drafts, no upcoming, no event in progress'
);

-- 2. Keyset pagination continues where the previous page stopped.
select is(pg_temp.past_titles('A', 2), array['completed_early', 'past_recent'], '2. first page');
select is(
  pg_temp.past_titles('A', 2,
    (select starts_at from public.events where id = pg_temp.fx('past_recent')), pg_temp.fx('past_recent')),
  array['past_cancelled', 'past_old'],
  '2. second page from the cursor'
);
select throws_ok(
  format($$ select * from public.list_past_events(%L, 20, now(), null) $$, pg_temp.fx('A')),
  '22023', null, '2. a half cursor is rejected'
);

-- 3. Managers do not receive drafts here either (drafts are never past events).
select pg_temp.login(pg_temp.fx('alice'));
select ok(not ('past_draft' = any (pg_temp.past_titles('A'))), '3. drafts are not listed, even for managers');

-- 4. Isolation: another community's past events are invisible.
select pg_temp.login(pg_temp.fx('frank'));
select is(pg_temp.past_titles('A'), '{}'::text[], '4. a member of B gets nothing from A');
select is(pg_temp.past_titles('B'), array['b_past'], '4. and sees B''s own past events');
select pg_temp.login(pg_temp.fx('grace'));
select is(pg_temp.past_titles('A'), '{}'::text[], '4. a pending member gets nothing');

-- 5. Anonymous callers cannot execute it.
reset role;
set local role anon;
select throws_ok(
  format($$ select * from public.list_past_events(%L) $$, pg_temp.fx('A')),
  '42501', null, '5. anon cannot call list_past_events'
);

select * from finish();
rollback;

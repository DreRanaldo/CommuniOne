-- Stage 12 / Migration 21: per-user rate limits for abuse-prone operations
--
-- Why in the database: the mobile and web apps talk to Supabase directly
-- (PostgREST + RPCs), so the database is the one place every request passes
-- through and that a client cannot skip. A fixed-window counter per
-- (user, action, window) is simple, transactional and needs no extra
-- infrastructure (no Redis, no gateway).
--
-- Limits apply to client requests only (private.actor_user_id() is NULL for
-- the service role, migrations and scheduled jobs). Rules live in a table so
-- operators can tune them without a migration:
--     update private.rate_limit_rules set max_count = 100 where action = 'post.create';
--
-- Exceeding a limit raises SQLSTATE 53400 (the same code the Stage 3
-- community-creation limit uses) with a HINT "retry_after_seconds=N".
--
-- Authentication attempts are rate limited by Supabase Auth itself
-- ([auth.rate_limit] in config.toml / dashboard), not here.

create table private.rate_limit_rules (
  action         text primary key,
  max_count      integer not null check (max_count >= 1),
  window_seconds integer not null check (window_seconds between 1 and 86400),
  description    text not null
);

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('post.create',          60,  600, 'Posts per user per 10 minutes'),
  ('comment.create',      120,  600, 'Comments per user per 10 minutes'),
  ('alert.create',         20, 3600, 'Alerts per user per hour'),
  ('invitation.create',    50, 3600, 'Invitations created per user per hour'),
  ('invitation.redeem',    30, 3600, 'Invitation redemptions per user per hour'),
  ('document.upload',      60, 3600, 'Document uploads started per user per hour');

create table private.rate_limit_counters (
  user_id      uuid        not null,
  action       text        not null references private.rate_limit_rules (action) on delete cascade,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (user_id, action, window_start)
);

-- For the purge of old windows.
create index rate_limit_counters_window_idx on private.rate_limit_counters (window_start);

comment on table private.rate_limit_counters is
  'Fixed-window request counters. Only user ids and counts, no content. Old windows are purged by purge_rate_limit_counters().';

-- Counts one hit for the current client user and raises 53400 when the
-- window's limit is exceeded. No-op for trusted server code and unknown
-- actions. Race-safe: the upsert serialises concurrent hits on one row.
create or replace function private.enforce_rate_limit(p_action text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user   uuid := private.actor_user_id();
  v_rule   private.rate_limit_rules;
  v_window timestamptz;
  v_hits   integer;
begin
  if v_user is null then
    return;
  end if;
  select * into v_rule from private.rate_limit_rules where action = p_action;
  if v_rule.action is null then
    return;
  end if;

  v_window := pg_catalog.to_timestamp(
    floor(extract(epoch from now()) / v_rule.window_seconds) * v_rule.window_seconds);

  insert into private.rate_limit_counters as c (user_id, action, window_start, hits)
  values (v_user, p_action, v_window, 1)
  on conflict (user_id, action, window_start) do update set hits = c.hits + 1
  returning c.hits into v_hits;

  if v_hits > v_rule.max_count then
    raise exception 'rate limit exceeded: at most % per % seconds (%)', v_rule.max_count, v_rule.window_seconds, p_action
      using errcode = '53400',
            hint = 'retry_after_seconds=' || ceil(extract(epoch from (v_window + make_interval(secs => v_rule.window_seconds) - now())))::integer;
  end if;
end;
$$;

revoke all on function private.enforce_rate_limit(text) from public, anon, authenticated, service_role;

-- Trigger adapter: the action is the trigger argument. SECURITY DEFINER so
-- it can call the (client-inaccessible) limiter; trigger functions cannot be
-- invoked directly.
create or replace function private.rate_limit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_rate_limit(tg_argv[0]);
  return new;
end;
$$;

revoke all on function private.rate_limit_trigger() from public, anon, authenticated, service_role;

create trigger posts_rate_limit
  before insert on public.posts
  for each row execute function private.rate_limit_trigger('post.create');

create trigger comments_rate_limit
  before insert on public.comments
  for each row execute function private.rate_limit_trigger('comment.create');

create trigger alerts_rate_limit
  before insert on public.alerts
  for each row execute function private.rate_limit_trigger('alert.create');

-- Invitation creation, redemption and document uploads run inside SECURITY
-- DEFINER functions; their inserts are counted the same way (the actor is
-- still the calling user there, because private.actor_user_id() reads the
-- request role, not the function owner). A refused redemption raises before
-- its redemption row is written, so only redemptions that would succeed count.
create trigger invitations_rate_limit
  before insert on public.invitations
  for each row execute function private.rate_limit_trigger('invitation.create');

create trigger invitation_redemptions_rate_limit
  before insert on public.invitation_redemptions
  for each row execute function private.rate_limit_trigger('invitation.redeem');

create trigger documents_rate_limit
  before insert on public.documents
  for each row execute function private.rate_limit_trigger('document.upload');

-- Housekeeping (service role, e.g. hourly): drop windows older than a day.
create or replace function public.purge_rate_limit_counters()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with d as (
    delete from private.rate_limit_counters where window_start < now() - interval '1 day' returning 1
  )
  select count(*)::integer from d;
$$;

revoke all on function public.purge_rate_limit_counters() from public, anon, authenticated;
grant execute on function public.purge_rate_limit_counters() to service_role;

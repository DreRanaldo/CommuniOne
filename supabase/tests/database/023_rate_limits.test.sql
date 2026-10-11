-- Stage 12: per-user rate limits for posts, comments, alerts, invitations, redemptions and uploads.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

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

-- Helpers (owner, before any login)
create function pg_temp.hits(p_user text, p_action text) returns integer language sql security definer as $$
  select coalesce(sum(hits), 0)::integer from private.rate_limit_counters where user_id = pg_temp.fx(p_user) and action = p_action
$$;
create function pg_temp.limit_to(p_action text, p_max integer) returns void language sql security definer as $$
  update private.rate_limit_rules set max_count = p_max, window_seconds = 3600 where action = p_action
$$;

select pg_temp.limit_to('post.create', 3);
select pg_temp.limit_to('comment.create', 2);
select pg_temp.limit_to('alert.create', 1);
select pg_temp.limit_to('invitation.create', 2);
select pg_temp.limit_to('invitation.redeem', 1);
select pg_temp.limit_to('document.upload', 1);

-- Posts
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok($$ insert into public.posts (community_id, body) select pg_temp.fx('A'), 'p' || i from generate_series(1, 3) i $$, 'posts within the limit succeed');
select throws_ok($$ insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'one too many') $$, '53400', null, 'the next post exceeds the limit (53400)');
select is(pg_temp.hits('carol', 'post.create'), 3, 'a refused attempt is rolled back and not counted');
select throws_like($$ insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'x') $$, '%rate limit exceeded%post.create%', 'the error names the limit, not internal details');

create temp table caught (hint text);
grant all on caught to public;
do $$
begin
  insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'x');
exception when sqlstate '53400' then
  declare h text; begin get stacked diagnostics h = pg_exception_hint; insert into caught values (h); end;
end $$;
select ok((select hint from caught) ~ '^retry_after_seconds=[0-9]+$', 'the error carries a retry-after hint');

select pg_temp.login(pg_temp.fx('dave'));
select lives_ok($$ insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'dave is separate') $$, 'limits are per user');
select pg_temp.login(pg_temp.fx('alice'));
select lives_ok($$ insert into public.posts (community_id, body) values (pg_temp.fx('B'), 'alice in B') $$, 'and per user across communities, not shared');

-- The window resets.
reset role;
update private.rate_limit_counters set window_start = window_start - interval '2 hours' where user_id = pg_temp.fx('carol');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok($$ insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'new window') $$, 'a new window allows posting again');

-- Trusted server code is not limited.
reset role;
set local role service_role;
select lives_ok(format($$ insert into public.posts (community_id, author_user_id, body) select %L, %L, 'svc ' || i from generate_series(1, 10) i $$, pg_temp.fx('A'), pg_temp.fx('carol')),
  'the service role is not rate limited');
reset role;

-- Comments
select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'thread') returning id) insert into fx select 'thread', id from i;
select lives_ok($$ insert into public.comments (post_id, body) values (pg_temp.fx('thread'), 'c1'), (pg_temp.fx('thread'), 'c2') $$, 'comments within the limit');
select throws_ok($$ insert into public.comments (post_id, body) values (pg_temp.fx('thread'), 'c3') $$, '53400', null, 'comments are rate limited');

-- Alerts
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok($$ insert into public.alerts (community_id, title, body, severity) values (pg_temp.fx('A'), 'a1', 'b', 'info') $$, 'first alert');
select throws_ok($$ insert into public.alerts (community_id, title, body, severity) values (pg_temp.fx('A'), 'a2', 'b', 'info') $$, '53400', null, 'alert creation is rate limited');

-- Invitations
create temp table toks (n serial, token text);
grant all on toks to public;
grant usage on sequence toks_n_seq to public;
select lives_ok($$ insert into toks (token) select token from public.create_invitation(pg_temp.fx('A')); insert into toks (token) select token from public.create_invitation(pg_temp.fx('A')) $$, 'invitations within the limit');
select throws_ok($$ select * from public.create_invitation(pg_temp.fx('A')) $$, '53400', null, 'invitation creation is rate limited');
reset role;
-- An invitation into a second community for the redemption limit.
select pg_temp.login(pg_temp.fx('bob'));
insert into toks (token) select token from public.create_invitation(pg_temp.fx('B'));
reset role;
insert into auth.users (id, email) values ('abababab-0000-4000-8000-00000000000a', 'joiner@example.test');
insert into auth.sessions (id, user_id) values ('abababab-0000-4000-8000-00000000000a', 'abababab-0000-4000-8000-00000000000a');
insert into fx values ('joiner', 'abababab-0000-4000-8000-00000000000a');
select pg_temp.login(pg_temp.fx('joiner'));
select lives_ok($$ select * from public.redeem_invitation((select token from toks order by n limit 1 offset 0)) $$, 'first redemption');
select throws_ok($$ select * from public.redeem_invitation((select token from toks order by n limit 1 offset 2)) $$, '53400', null, 'redemptions are rate limited');
select throws_ok($$ select * from public.redeem_invitation('ci_' || repeat('0', 64)) $$, 'P0002', null, 'an invalid token is still reported as invalid (no oracle change)');

-- Document uploads
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok($$ select * from public.create_document_upload(pg_temp.fx('A'), 'a.pdf', 'application/pdf', 10) $$, 'first upload');
select throws_ok($$ select * from public.create_document_upload(pg_temp.fx('A'), 'b.pdf', 'application/pdf', 10) $$, '53400', null, 'document uploads are rate limited');

-- Clients cannot see or reset counters or rules.
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select * from private.rate_limit_counters $$, '42501', null, 'clients cannot read counters');
select throws_ok($$ delete from private.rate_limit_counters $$, '42501', null, 'clients cannot reset counters');
select throws_ok($$ update private.rate_limit_rules set max_count = 1000000 $$, '42501', null, 'clients cannot change rules');
select throws_ok($$ select private.enforce_rate_limit('post.create') $$, '42501', null, 'clients cannot call the limiter');
select throws_ok($$ select public.purge_rate_limit_counters() $$, '42501', null, 'clients cannot purge counters');
reset role;
set local role service_role;
select lives_ok($$ select public.purge_rate_limit_counters() $$, 'the service role purges old windows');
reset role;

-- Counters hold no content.
select is_empty($$ select 1 from information_schema.columns where table_schema = 'private' and table_name = 'rate_limit_counters' and column_name not in ('user_id', 'action', 'window_start', 'hits') $$,
  'counters store only user id, action, window and count');

select * from finish();
rollback;

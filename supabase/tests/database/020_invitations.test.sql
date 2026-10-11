-- Pre-Stage 12: invitations (Stage 4): token security, redemption, limits, revocation, isolation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(47);

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

-- Extra users who are not yet members anywhere.
insert into auth.users (id, email)
select ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid, 'joiner' || i || '@example.test' from generate_series(1, 6) as i;
insert into auth.sessions (id, user_id)
select ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid, ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 6) as i;
insert into fx select 'j' || i, ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 6) as i;

create temp table tokens (key text primary key, token text);
grant all on tokens to public;
create function pg_temp.tok(p text) returns text language sql as $$ select token from tokens where key = p $$;
create function pg_temp.invite(p_key text, p_community text, p_max integer default null, p_expires interval default interval '7 days')
returns void language sql as $$
  with i as (select * from public.create_invitation(pg_temp.fx(p_community), p_expires, p_max)),
       t as (insert into tokens select p_key, i.token from i)
  insert into fx select p_key, i.invitation_id from i;
$$;
create function pg_temp.redeem(p_user text, p_key text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.login(pg_temp.fx(p_user));
  select membership_status into v from public.redeem_invitation(pg_temp.tok(p_key));
  return v;
end;
$$;
create function pg_temp.inv(p_key text) returns public.invitations language sql security definer as $$
  select * from public.invitations where id = pg_temp.fx(p_key)
$$;

-- =========================================================================
-- 1-5. Creation and token security
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('inv', 'A');
select results_eq(
  $$ select community_id, created_by, status, use_count from pg_temp.inv('inv') $$,
  $$ values (pg_temp.fx('A'), pg_temp.fx('erin'), 'active', 0) $$,
  '1/3. an authorized user (members.invite) creates an invitation for her community'
);
select ok(pg_temp.tok('inv') ~ '^ci_[0-9a-f]{64}$', '4. the token is 64 random hex characters (244 bits)');
select ok(
  (select token_hash from pg_temp.inv('inv')) = encode(sha256(convert_to(pg_temp.tok('inv'), 'UTF8')), 'hex')
  and (select token_hash from pg_temp.inv('inv')) <> pg_temp.tok('inv'),
  '4. only the SHA-256 hash is stored, never the token'
);
reset role;
select is_empty(
  $$ select 1 from public.invitations i where to_jsonb(i)::text like '%' || substr(pg_temp.tok('inv'), 4, 20) || '%' $$,
  '4. no part of the raw token is stored anywhere in the invitation'
);
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('t' || i, 'A') from generate_series(1, 20) as i;
select is((select count(distinct token)::int from tokens), 21, '5. tokens are unique (21 of 21)');
select throws_ok(
  $$ select * from public.create_invitation(gen_random_uuid()) $$,
  '42501', null, 'invitations cannot be created for unknown communities'
);
select throws_like(
  format($$ select * from public.create_invitation(%L, interval '90 days') $$, pg_temp.fx('A')),
  '%between 1 hour and 30 days%', 'expiry is bounded'
);

select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select * from public.create_invitation(%L) $$, pg_temp.fx('A')), '42501', null, '2. a normal member cannot create invitations');
select is_empty(format($$ select * from public.list_invitations(%L) $$, pg_temp.fx('A')), '2. ...or list them');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(format($$ select * from public.create_invitation(%L) $$, pg_temp.fx('A')), '42501', null, '14. a member of B cannot create invitations for A');
select pg_temp.login(pg_temp.fx('bob'));
select pg_temp.invite('inv_b', 'B');

-- Clients cannot read or tamper with invitations directly.
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok($$ select token_hash from public.invitations $$, '42501', null, '4. token hashes are not readable by clients');
select throws_ok(format($$ update public.invitations set use_count = 0 where id = %L $$, pg_temp.fx('inv')), '42501', null, '14. use_count cannot be manipulated');
select throws_ok(format($$ update public.invitations set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('inv')), '42501', null, '14. the community cannot be changed');
select throws_ok(format($$ update public.invitations set expires_at = now() + interval '1 year' where id = %L $$, pg_temp.fx('inv')), '42501', null, 'expiry cannot be extended');
select throws_ok(format($$ insert into public.invitations (community_id, token_hash, expires_at) values (%L, repeat('a', 64), now() + interval '1 day') $$, pg_temp.fx('A')), '42501', null, 'invitations cannot be inserted directly');

-- =========================================================================
-- 6 / 10 / 12 / 13. Redemption creates the right membership with the default role
-- =========================================================================
select is(pg_temp.redeem('j1', 'inv'), 'active', '6. a valid invitation is redeemed');
reset role;
select results_eq(
  $$ select m.community_id, m.status, array_agg(r.name) from public.memberships m
     join public.membership_roles mr on mr.membership_id = m.id join public.roles r on r.id = mr.role_id
     where m.user_id = pg_temp.fx('j1') group by m.community_id, m.status $$,
  $$ values (pg_temp.fx('A'), 'active', array['Member']) $$,
  '12/13. the membership is in the invitation''s community, active, with exactly the default Member role'
);
select is((pg_temp.inv('inv')).use_count, 1, '10. use_count is incremented');
select is((select count(*)::int from public.invitation_redemptions where invitation_id = pg_temp.fx('inv') and user_id = pg_temp.fx('j1')), 1, '10. the redemption is tracked');
select pg_temp.login(pg_temp.fx('j1'));
select ok(public.has_community_permission(pg_temp.fx('A'), 'posts.create'), '13. the new member has Member permissions');
select ok(not public.has_community_permission(pg_temp.fx('A'), 'members.invite'), '13. ...and nothing more');

-- 11. Duplicate memberships are refused (and do not consume a use)
select throws_like($$ select pg_temp.redeem('j1', 'inv') $$, '%already a member%', '11. redeeming again does not duplicate the membership');
select throws_like($$ select pg_temp.redeem('carol', 'inv') $$, '%already a member%', '11. existing members are not duplicated');
select is((pg_temp.inv('inv')).use_count, 1, '10. failed redemptions do not change use_count');

-- 14. A token for B creates a membership in B, never in A
select is(pg_temp.redeem('j2', 'inv_b'), 'active', '14. a B invitation is redeemed');
reset role;
select is((select array_agg(community_id) from public.memberships where user_id = pg_temp.fx('j2')), array[pg_temp.fx('B')], '14. ...and the membership is in B only');

-- Invitations never bypass membership security
update public.memberships set status = 'suspended' where id = pg_temp.fx('dave@A');
select throws_like($$ select pg_temp.redeem('dave', 'inv') $$, '%suspended%', 'a suspended member cannot reinstate herself with an invitation');
reset role;
update public.memberships set status = 'left' where id = pg_temp.fx('carol@A');
select is(pg_temp.redeem('carol', 'inv'), 'active', 'a former member can rejoin with an invitation');
reset role;
select is(
  (select array_agg(r.name) from public.membership_roles mr join public.roles r on r.id = mr.role_id where mr.membership_id = pg_temp.fx('carol@A')),
  array['Member'], '...with the default role only'
);
select throws_like($$ select pg_temp.redeem('j3', 'nope') $$, '%invalid invitation%', 'an unknown token is rejected');
select throws_like(format($$ select pg_temp.redeem('j3', %L) $$, 'x'), '%invalid invitation%', 'a guessed token is rejected');

-- =========================================================================
-- 9. Maximum uses
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('limited', 'A', 2);
select is(pg_temp.redeem('j3', 'limited'), 'active', '9. first use');
select is(pg_temp.redeem('j4', 'limited'), 'active', '9. second use');
select throws_like($$ select pg_temp.redeem('j5', 'limited') $$, '%expired%', '9. the third use is refused');
reset role;
select results_eq($$ select use_count, status from pg_temp.inv('limited') $$, $$ values (2, 'expired') $$, '9/10. use_count is exactly 2 and the invitation is exhausted');

-- =========================================================================
-- 7. Expiry
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('old', 'A');
reset role;
-- Back-date it (created_at is protected, so lift the guard for this setup step only).
alter table public.invitations disable trigger invitations_protect;
update public.invitations set created_at = now() - interval '10 days', expires_at = now() - interval '1 minute' where id = pg_temp.fx('old');
alter table public.invitations enable trigger invitations_protect;
select throws_like($$ select pg_temp.redeem('j5', 'old') $$, '%expired%', '7. an expired invitation cannot be redeemed');
reset role;
set local role service_role;
select ok(public.expire_invitations() >= 1, '7. the housekeeping job marks time-expired invitations');
reset role;
select is((pg_temp.inv('old')).status, 'expired', '7. ...as expired');

-- =========================================================================
-- 8. Revocation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.revoke_invitation(%L) $$, pg_temp.fx('inv')), 'P0002', null, '8. a normal member cannot revoke invitations');
select pg_temp.login(pg_temp.fx('bob'));
select throws_ok(format($$ select public.revoke_invitation(%L) $$, pg_temp.fx('inv')), 'P0002', null, '14. the Owner of B cannot revoke A''s invitations');
select pg_temp.login(pg_temp.fx('alice'));
select ok(public.revoke_invitation(pg_temp.fx('inv')), '8. an authorized user revokes an invitation');
select throws_like($$ select pg_temp.redeem('j5', 'inv') $$, '%revoked%', '8. a revoked invitation cannot be redeemed');

-- An invitation is only as good as its creator's current authority.
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('demoted', 'A');
reset role;
delete from public.membership_roles where membership_id = pg_temp.fx('erin@A');
select throws_like($$ select pg_temp.redeem('j6', 'demoted') $$, '%no longer valid%', 'invitations stop working when their creator loses members.invite');

-- Audit trail
reset role;
select ok(
  (select count(*) from public.audit_logs where action = 'invitation.created') >= 2
  and exists (select 1 from public.audit_logs where action = 'invitation.redeemed' and (metadata ->> 'user_id')::uuid = pg_temp.fx('j1'))
  and exists (select 1 from public.audit_logs where action = 'invitation.revoked' and actor_user_id = pg_temp.fx('alice')),
  'creation, redemption and revocation are audited'
);
select is_empty($$ select 1 from public.audit_logs where metadata::text ~ 'ci_[0-9a-f]{20}' $$, 'tokens never appear in the audit log');

reset role;
set local role anon;
select throws_ok($$ select * from public.redeem_invitation('ci_x') $$, '42501', null, 'anon cannot redeem invitations');

-- A suspended account (platform level) cannot join communities.
reset role;
select pg_temp.login(pg_temp.fx('alice'));
select pg_temp.invite('for_suspended', 'A');
reset role;
update public.profiles set status = 'suspended' where id = pg_temp.fx('j4');
select throws_ok($$ select pg_temp.redeem('j4', 'for_suspended') $$, '42501', null, 'a suspended account cannot redeem invitations');

select * from finish();
rollback;

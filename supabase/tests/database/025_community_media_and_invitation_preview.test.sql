-- RN-05: community logo/cover uploads (public bucket, community.update), media pointers, purge; read-only invitation preview.
begin;
create extension if not exists pgtap with schema extensions;

select plan(43);

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
create function pg_temp.obj(p_community text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_community)::text || '/' || p_file
$$;
create function pg_temp.store(p_name text) returns void language sql security definer as $$
  insert into storage.objects (bucket_id, name, metadata) values ('community-media', p_name, '{"size": 1000, "mimetype": "image/jpeg"}')
$$;
create function pg_temp.community(p_key text) returns public.communities language sql security definer as $$
  select * from public.communities where id = pg_temp.fx(p_key)
$$;
create function pg_temp.media_count(p_community text) returns bigint language sql security definer as $$
  select count(*) from storage.objects where bucket_id = 'community-media' and name like pg_temp.fx(p_community)::text || '/%'
$$;

-- Invitations (as in 020)
insert into auth.users (id, email)
select ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid, 'joiner' || i || '@example.test' from generate_series(1, 4) as i;
insert into auth.sessions (id, user_id)
select ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid, ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 4) as i;
insert into fx select 'j' || i, ('b0b0b0b0-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 4) as i;
create temp table tokens (key text primary key, token text);
grant all on tokens to public;
create function pg_temp.tok(p text) returns text language sql as $$ select token from tokens where key = p $$;
create function pg_temp.invite(p_key text, p_community text, p_max integer default null) returns void language sql as $$
  with i as (select * from public.create_invitation(pg_temp.fx(p_community), interval '7 days', p_max)),
       t as (insert into tokens select p_key, i.token from i)
  insert into fx select p_key, i.invitation_id from i;
$$;
create function pg_temp.active_members(p_key text) returns integer language sql security definer as $$
  select count(*)::integer from public.memberships where community_id = pg_temp.fx(p_key) and status = 'active'
$$;
create function pg_temp.use_count(p_key text) returns integer language sql security definer as $$
  select use_count from public.invitations where id = pg_temp.fx(p_key)
$$;

-- =========================================================================
-- Community media: bucket and uploads
-- =========================================================================
select is((select public from storage.buckets where id = 'community-media'), true,
  'community-media is public (branding shown to invitees), with unguessable paths');

select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('community-media', %L) $$, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png')),
  'an Admin (community.update) uploads into her community''s folder');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('community-media', %L) $$, pg_temp.obj('A', '22222222-2222-4222-8222-222222222222.png')),
  '42501', null, 'a Member (no community.update) cannot upload');
select pg_temp.login(pg_temp.fx('bob'));
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('community-media', %L) $$, pg_temp.obj('A', '33333333-3333-4333-8333-333333333333.png')),
  '42501', null, 'the Owner of B cannot upload into A''s folder');
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('community-media', %L) $$, pg_temp.fx('A')::text || '/../x.png'),
  '42501', null, 'malformed paths are refused');
select is_empty(format($$ update storage.objects set name = %L where bucket_id = 'community-media' returning 1 $$, pg_temp.obj('A', '44444444-4444-4444-8444-444444444444.png')),
  'files can never be renamed or replaced');

-- =========================================================================
-- communities.logo_path / cover_image_path
-- =========================================================================
select lives_ok(format($$ update public.communities set logo_path = %L where id = %L $$, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png'), pg_temp.fx('A')),
  'an Admin sets the logo to an uploaded file');
select is((pg_temp.community('A')).logo_path, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png'), '...and it is saved');
select throws_ok(format($$ update public.communities set cover_image_path = %L where id = %L $$, pg_temp.obj('A', '99999999-9999-4999-8999-999999999999.jpg'), pg_temp.fx('A')),
  '22023', null, 'a file that was never uploaded is refused');
reset role;
select pg_temp.store(pg_temp.obj('B', '55555555-5555-4555-8555-555555555555.jpg'));
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ update public.communities set cover_image_path = %L where id = %L $$, pg_temp.obj('B', '55555555-5555-4555-8555-555555555555.jpg'), pg_temp.fx('A')),
  '42501', null, 'another community''s image cannot be used');
select throws_ok(format($$ update public.communities set logo_path = 'https://evil.example/x.png' where id = %L $$, pg_temp.fx('A')),
  '42501', null, 'logo_path must be a storage path, not a URL');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(format($$ update public.communities set logo_path = null where id = %L returning 1 $$, pg_temp.fx('A')),
  'a Member cannot change the logo');
select pg_temp.login(pg_temp.fx('alice'));
select is_empty(format($$ update public.communities set logo_path = null where id = %L returning 1 $$, pg_temp.fx('B')),
  'a Member of B (alice) cannot change B''s logo');

-- my_communities() returns the logo path for the switcher.
select pg_temp.login(pg_temp.fx('carol'));
select is((select logo_path from public.my_communities() where community_id = pg_temp.fx('A')),
  pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png'), 'my_communities() includes logo_path');

-- Reads through the API: members only (public URLs are served by Storage itself).
select is((select count(*) from storage.objects where bucket_id = 'community-media' and name like pg_temp.fx('A')::text || '/%'), 1::bigint,
  'a member can list her community''s media');
select pg_temp.login(pg_temp.fx('frank'));
select is((select count(*) from storage.objects where bucket_id = 'community-media' and name like pg_temp.fx('A')::text || '/%'), 0::bigint,
  'members of other communities cannot list it');
reset role;
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'community-media'), 0::bigint, 'signed-out clients cannot list media');
reset role;

-- Deleting: never the current images; old ones by community.update holders only.
-- (Supabase blocks SQL deletes on storage.objects unless allowed; the Storage
-- API deletes the same way, under the same RLS policies.)
select set_config('storage.allow_delete_query', 'true', true);
select pg_temp.login(pg_temp.fx('erin'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'community-media' and name = %L returning 1 $$, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png')),
  'the current logo file cannot be deleted');
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('community-media', %L) $$, pg_temp.obj('A', '66666666-6666-4666-8666-666666666666.webp')),
  'a replacement logo is uploaded');
select lives_ok(format($$ update public.communities set logo_path = %L where id = %L $$, pg_temp.obj('A', '66666666-6666-4666-8666-666666666666.webp'), pg_temp.fx('A')),
  '...and set');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'community-media' and name = %L returning 1 $$, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png')),
  'a Member cannot delete community media');
select pg_temp.login(pg_temp.fx('erin'));
select isnt_empty(format($$ delete from storage.objects where bucket_id = 'community-media' and name = %L returning 1 $$, pg_temp.obj('A', '11111111-1111-4111-8111-111111111111.png')),
  'the replaced file is deleted by an Admin');

-- Purge listing: service role only.
select throws_ok($$ select * from public.list_community_media_to_purge() $$, '42501', null, 'clients cannot list files to purge');
reset role;
update storage.objects set created_at = now() - interval '2 days' where bucket_id = 'community-media';
set local role service_role;
select results_eq(
  $$ select name from public.list_community_media_to_purge(interval '1 day') $$,
  format($$ values (%L::text) $$, pg_temp.obj('B', '55555555-5555-4555-8555-555555555555.jpg')),
  'only unreferenced files are listed for purging (never the current logo)'
);
reset role;

-- =========================================================================
-- preview_invitation()
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select pg_temp.invite('p', 'A');
select pg_temp.invite('rev', 'A');
select pg_temp.invite('one', 'A', 1);
select pg_temp.invite('old', 'A');
select pg_temp.login(pg_temp.fx('alice'));
select ok(public.revoke_invitation(pg_temp.fx('rev')), 'setup: an invitation is revoked');
reset role;
alter table public.invitations disable trigger invitations_protect;
update public.invitations set created_at = now() - interval '10 days', expires_at = now() - interval '1 minute' where id = pg_temp.fx('old');
alter table public.invitations enable trigger invitations_protect;
select pg_temp.login(pg_temp.fx('j1'));
select is((select membership_status from public.redeem_invitation(pg_temp.tok('one'))), 'active', 'setup: a single-use invitation is used');

select pg_temp.login(pg_temp.fx('j2'));
select results_eq(
  $$ select community_id, name, community_type, logo_path, membership_status from public.preview_invitation(pg_temp.tok('p')) $$,
  format($$ values (%L::uuid, %L::text, %L::text, %L::text, null::text) $$,
    pg_temp.fx('A'), (pg_temp.community('A')).name, (pg_temp.community('A')).community_type, (pg_temp.community('A')).logo_path),
  'a token holder sees the community before joining'
);
select is((select member_count from public.preview_invitation(pg_temp.tok('p'))),
  pg_temp.active_members('A'),
  'the preview shows the number of active members');
select is(pg_temp.use_count('p'), 0, 'a preview consumes nothing');
select is((select count(*) from public.my_communities() where community_id = pg_temp.fx('A')), 0::bigint, 'a preview does not join');

-- The same refusals as redeem_invitation().
select throws_ok($$ select * from public.preview_invitation('ci_' || repeat('0', 64)) $$, 'P0002', 'invalid invitation', 'an unknown token is refused like redemption');
select throws_ok($$ select * from public.preview_invitation('not a token') $$, 'P0002', 'invalid invitation', 'garbage is refused the same way');
select throws_ok($$ select * from public.preview_invitation(pg_temp.tok('rev')) $$, '22023', 'this invitation has been revoked', 'a revoked invitation is refused');
select throws_ok($$ select * from public.redeem_invitation(pg_temp.tok('rev')) $$, '22023', 'this invitation has been revoked', '...exactly as redemption refuses it');
select throws_ok($$ select * from public.preview_invitation(pg_temp.tok('old')) $$, '22023', 'this invitation has expired', 'an expired invitation is refused');
select throws_ok($$ select * from public.preview_invitation(pg_temp.tok('one')) $$, '22023', 'this invitation has expired', 'a used-up invitation is refused (its last use marked it expired)');
select throws_ok($$ select * from public.redeem_invitation(pg_temp.tok('one')) $$, '22023', 'this invitation has expired', '...exactly as redemption refuses it');

-- Existing members: told, not refused (redemption refuses them).
select pg_temp.login(pg_temp.fx('carol'));
select is((select membership_status from public.preview_invitation(pg_temp.tok('p'))), 'active', 'an existing member sees "active"');
select throws_ok($$ select * from public.redeem_invitation(pg_temp.tok('p')) $$, '23505', null, '...and redemption would refuse her');
select pg_temp.login(pg_temp.fx('grace'));
select is((select membership_status from public.preview_invitation(pg_temp.tok('p'))), 'pending', 'a pending applicant sees "pending" (redeeming admits her)');

-- The creator's authority still counts.
reset role;
delete from public.membership_roles where membership_id = pg_temp.fx('erin@A');
select pg_temp.login(pg_temp.fx('j3'));
select throws_ok($$ select * from public.preview_invitation(pg_temp.tok('p')) $$, '22023', 'this invitation is no longer valid', 'an invitation whose creator lost members.invite is refused');

-- Callers
reset role;
set local role anon;
select throws_ok($$ select * from public.preview_invitation('x') $$, '42501', null, 'signed-out clients cannot preview');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.fx('j4'), 'role', 'authenticated', 'session_id', gen_random_uuid())::text, true);
set local role authenticated;
select throws_ok($$ select * from public.preview_invitation('x') $$, '42501', 'authentication required', 'a session that is not live cannot preview');
reset role;

select * from finish();
rollback;

-- RN-03: profile avatars: private bucket, own-folder uploads, profile pointer checks, visibility, deletion, purge.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

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
create function pg_temp.obj(p_user text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_user)::text || '/' || p_file
$$;
create function pg_temp.store(p_name text) returns void language sql security definer as $$
  insert into storage.objects (bucket_id, name, metadata) values ('avatars', p_name, '{"size": 1000, "mimetype": "image/jpeg"}')
$$;
create function pg_temp.objects_for(p_user text) returns bigint language sql security definer as $$
  select count(*) from storage.objects where bucket_id = 'avatars' and name like pg_temp.fx(p_user)::text || '/%'
$$;
create function pg_temp.avatar_of(p_user text) returns text language sql security definer as $$
  select avatar_path from public.profiles where id = pg_temp.fx(p_user)
$$;

select is((select public from storage.buckets where id = 'avatars'), false, 'the avatars bucket is private');

-- Upload: own folder only.
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, pg_temp.obj('carol', '11111111-1111-4111-8111-111111111111.jpg')),
  'a user uploads an avatar into their own folder');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, pg_temp.obj('dave', '22222222-2222-4222-8222-222222222222.jpg')),
  '42501', null, 'nobody can upload into someone else''s folder');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, pg_temp.fx('carol')::text || '/../evil.jpg'),
  '42501', null, 'malformed paths are refused');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, pg_temp.obj('carol', '33333333-3333-4333-8333-333333333333.gif')),
  '42501', null, 'only jpg, png and webp names are accepted');
select is_empty(format($$ update storage.objects set name = %L where bucket_id = 'avatars' returning 1 $$, pg_temp.obj('carol', '44444444-4444-4444-8444-444444444444.jpg')),
  'files can never be renamed or replaced');

-- Point the profile at it.
select lives_ok(format($$ update public.profiles set avatar_path = %L where id = %L $$, pg_temp.obj('carol', '11111111-1111-4111-8111-111111111111.jpg'), pg_temp.fx('carol')),
  'a user sets their avatar to their own uploaded file');
select is(pg_temp.avatar_of('carol'), pg_temp.obj('carol', '11111111-1111-4111-8111-111111111111.jpg'), '...and it is saved');
select throws_ok(format($$ update public.profiles set avatar_path = %L where id = %L $$, pg_temp.obj('carol', '99999999-9999-4999-8999-999999999999.jpg'), pg_temp.fx('carol')),
  '22023', null, 'an avatar file that was never uploaded is refused');
reset role;
select pg_temp.store(pg_temp.obj('dave', '55555555-5555-4555-8555-555555555555.png'));
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ update public.profiles set avatar_path = %L where id = %L $$, pg_temp.obj('dave', '55555555-5555-4555-8555-555555555555.png'), pg_temp.fx('carol')),
  '42501', null, 'someone else''s image cannot become your avatar');
select throws_ok(format($$ update public.profiles set avatar_path = 'https://evil.example/x.jpg' where id = %L $$, pg_temp.fx('carol')),
  '42501', null, 'avatar_path must be a storage path, not a URL');
select is_empty(format($$ update public.profiles set avatar_path = null where id = %L returning 1 $$, pg_temp.fx('dave')),
  'nobody can change another user''s avatar');
select isnt(pg_temp.avatar_of('dave'), 'x', 'dave''s profile is untouched');

-- Read: owner, co-members (same rule as profiles), not other communities.
select is((select count(*) from storage.objects where bucket_id = 'avatars' and name like pg_temp.fx('carol')::text || '/%'), 1::bigint,
  'the owner can read their avatar file');
select pg_temp.login(pg_temp.fx('erin'));
select is((select count(*) from storage.objects where bucket_id = 'avatars' and name like pg_temp.fx('carol')::text || '/%'), 1::bigint,
  'a co-member can read the avatar (as they can read the profile)');
select pg_temp.login(pg_temp.fx('frank'));
select is((select count(*) from storage.objects where bucket_id = 'avatars' and name like pg_temp.fx('carol')::text || '/%'), 0::bigint,
  'a member of another community cannot read it');
reset role;
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'avatars'), 0::bigint, 'signed-out clients cannot read avatars');
reset role;

-- Delete: own files except the current one.
select set_config('storage.allow_delete_query', 'true', true);
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'avatars' and name = %L returning 1 $$, pg_temp.obj('carol', '11111111-1111-4111-8111-111111111111.jpg')),
  'the file the profile uses cannot be deleted');
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, pg_temp.obj('carol', '66666666-6666-4666-8666-666666666666.webp')), 'upload a replacement');
select lives_ok(format($$ update public.profiles set avatar_path = %L where id = %L $$, pg_temp.obj('carol', '66666666-6666-4666-8666-666666666666.webp'), pg_temp.fx('carol')), 'switch to it');
select isnt_empty(format($$ delete from storage.objects where bucket_id = 'avatars' and name = %L returning 1 $$, pg_temp.obj('carol', '11111111-1111-4111-8111-111111111111.jpg')),
  'the replaced file can now be deleted by its owner');
select is_empty(format($$ delete from storage.objects where bucket_id = 'avatars' and name = %L returning 1 $$, pg_temp.obj('dave', '55555555-5555-4555-8555-555555555555.png')),
  'nobody can delete someone else''s avatar file');
reset role;

-- Purge listing (service role only).
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select * from public.list_avatar_files_to_purge() $$, '42501', null, 'clients cannot list files to purge');
reset role;
update storage.objects set created_at = now() - interval '2 days' where bucket_id = 'avatars';
set local role service_role;
select results_eq($$ select name from public.list_avatar_files_to_purge() order by name $$,
  format($$ values (%L::text) $$, pg_temp.obj('dave', '55555555-5555-4555-8555-555555555555.png')),
  'unused files are listed for purge; files in use are not');
reset role;

-- Account deletion: the deleted user's avatar becomes purgeable personal data.
select pg_temp.login(pg_temp.fx('carol'));
select public.delete_my_account();
reset role;
update storage.objects set created_at = now() - interval '2 days' where bucket_id = 'avatars';
set local role service_role;
select ok(pg_temp.obj('carol', '66666666-6666-4666-8666-666666666666.webp') in (select name from public.list_avatar_files_to_purge()),
  'a deleted account''s avatar is listed for purge');
reset role;

select * from finish();
rollback;

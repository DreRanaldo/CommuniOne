-- Feed redesign: post pictures: private bucket, own-folder uploads, attach only at creation, idempotent create_post, visibility, isolation, purge.
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

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

-- Helpers (owner, before any login).
create function pg_temp.img(p_community text, p_user text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_community)::text || '/' || pg_temp.fx(p_user)::text || '/' || p_file
$$;
create function pg_temp.upload(p_name text) returns void language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values ('post-images', p_name, '{"size": 1000, "mimetype": "image/jpeg"}');
end;
$$;
create function pg_temp.images_json(variadic p_paths text[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('path', p, 'width', 1080, 'height', 1350) order by o), '[]'::jsonb)
  from unnest(p_paths) with ordinality as t(p, o)
$$;
create function pg_temp.image_count(p_post uuid) returns bigint language sql security definer as $$
  select count(*) from public.post_images where post_id = p_post
$$;
create function pg_temp.post_count(p_user text) returns bigint language sql security definer as $$
  select count(*) from public.posts where author_user_id = pg_temp.fx(p_user)
$$;

select is((select public from storage.buckets where id = 'post-images'), false, 'the post-images bucket is private');

-- =========================================================================
-- 1. Upload: own folder of a community where you may post
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '1. a member uploads a picture into their own folder of their community');
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'carol', '22222222-2222-4222-8222-222222222222.png')),
  '1. a second picture');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('A', 'dave', '33333333-3333-4333-8333-333333333333.jpg')),
  '42501', null, '1. nobody uploads into someone else''s folder');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.img('B', 'carol', '44444444-4444-4444-8444-444444444444.jpg')),
  '42501', null, '1. nobody uploads into a community they do not belong to');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.fx('A')::text || '/' || pg_temp.fx('carol')::text || '/../x.jpg'),
  '42501', null, '1. malformed paths are refused');
select is_empty(format($$ update storage.objects set name = %L where bucket_id = 'post-images' returning 1 $$,
  pg_temp.img('A', 'carol', '55555555-5555-4555-8555-555555555555.jpg')), '1. files can never be renamed or replaced');

-- =========================================================================
-- 2. create_post: post + pictures atomically, in order
-- =========================================================================
insert into fx select 'p1', id from public.create_post(pg_temp.fx('A'), 'Garden day!',
  pg_temp.images_json(pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg'),
                      pg_temp.img('A', 'carol', '22222222-2222-4222-8222-222222222222.png')),
  '99999999-0000-4000-8000-000000000001');
select results_eq(
  format($$ select storage_path, position, width, height from public.post_images where post_id = %L order by position $$, pg_temp.fx('p1')),
  format($$ values (%L, 0::smallint, 1080, 1350), (%L, 1::smallint, 1080, 1350) $$,
    pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg'), pg_temp.img('A', 'carol', '22222222-2222-4222-8222-222222222222.png')),
  '2. the post''s pictures are stored in display order'
);
select is((select community_id from public.post_images where post_id = pg_temp.fx('p1') limit 1), pg_temp.fx('A'),
  '2. pictures belong to the post''s community');

-- Idempotent: the same request id returns the same post, creates nothing new.
select is(
  (select id from public.create_post(pg_temp.fx('A'), 'Garden day!', '[]'::jsonb, '99999999-0000-4000-8000-000000000001')),
  pg_temp.fx('p1'), '2. a retried publish returns the first post');
select is(pg_temp.post_count('carol'), 1::bigint, '2. ...and creates no duplicate');
select is(pg_temp.image_count(pg_temp.fx('p1')), 2::bigint, '2. ...nor duplicate pictures');
select throws_ok(format($$ select * from public.create_post(%L, 'x', '[]'::jsonb, '99999999-0000-4000-8000-000000000001') $$, pg_temp.fx('B')),
  '22023', null, '2. a request id cannot be reused for another community');

-- A failed publish leaves nothing behind (atomic).
select throws_ok(format($$ select * from public.create_post(%L, 'Missing file', %L::jsonb) $$, pg_temp.fx('A'),
    pg_temp.images_json(pg_temp.img('A', 'carol', '66666666-6666-4666-8666-666666666666.jpg'))),
  '22023', null, '2. a picture that was never uploaded is refused');
select is(pg_temp.post_count('carol'), 1::bigint, '2. ...and no post was created');
select throws_ok(format($$ select * from public.create_post(%L, 'Too many', %L::jsonb) $$, pg_temp.fx('A'),
    (select jsonb_agg(jsonb_build_object('path', 'x', 'width', 1, 'height', 1)) from generate_series(1, 11))),
  '22023', null, '2. at most 10 pictures');
select throws_ok(format($$ select * from public.create_post(%L, '   ', '[]'::jsonb) $$, pg_temp.fx('A')),
  '23514', null, '2. a caption is required');

-- =========================================================================
-- 3. Attaching: only your own file, only to your own post, only at creation
-- =========================================================================
reset role;
select pg_temp.upload(pg_temp.img('A', 'dave', '77777777-7777-4777-8777-777777777777.jpg'));
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select * from public.create_post(%L, 'Not my photo', %L::jsonb) $$, pg_temp.fx('A'),
    pg_temp.images_json(pg_temp.img('A', 'dave', '77777777-7777-4777-8777-777777777777.jpg'))),
  '42501', null, '3. someone else''s upload cannot be attached');

-- Pictures cannot be added to a post after it was created.
reset role;
-- (as if it had been created a minute ago: triggers off for this fixture write only)
set local session_replication_role = replica;
update public.posts set created_at = now() - interval '1 minute' where id = pg_temp.fx('p1');
set local session_replication_role = origin;
select pg_temp.login(pg_temp.fx('carol'));
select pg_temp.upload(pg_temp.img('A', 'carol', '88888888-8888-4888-8888-888888888888.jpg'));
select throws_ok(format($$ insert into public.post_images (post_id, community_id, storage_path, position, width, height) values (%L, %L, %L, 5, 10, 10) $$,
    pg_temp.fx('p1'), pg_temp.fx('A'), pg_temp.img('A', 'carol', '88888888-8888-4888-8888-888888888888.jpg')),
  '42501', null, '3. pictures cannot be added to an existing post');
select throws_ok(format($$ delete from public.post_images where post_id = %L $$, pg_temp.fx('p1')),
  '42501', null, '3. nor removed');
select throws_ok(format($$ update public.post_images set position = 3 where post_id = %L $$, pg_temp.fx('p1')),
  '42501', null, '3. nor changed');

-- Someone else's post cannot receive pictures.
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ insert into public.post_images (post_id, community_id, storage_path, position, width, height) values (%L, %L, %L, 6, 10, 10) $$,
    pg_temp.fx('p1'), pg_temp.fx('A'), pg_temp.img('A', 'dave', '77777777-7777-4777-8777-777777777777.jpg')),
  '42501', null, '3. nobody attaches pictures to someone else''s post');

-- =========================================================================
-- 4. Reading: who can see the post sees its pictures; nobody else
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select is((select count(*) from public.post_images where post_id = pg_temp.fx('p1')), 2::bigint, '4. members see a post''s pictures');
select is((select count(*) from storage.objects where bucket_id = 'post-images'
           and name = pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), 1::bigint,
  '4. ...and can read the files (signed URLs)');
select is((select count(*) from storage.objects where bucket_id = 'post-images'
           and name = pg_temp.img('A', 'carol', '88888888-8888-4888-8888-888888888888.jpg')), 0::bigint,
  '4. an unattached upload is private to its uploader');

select pg_temp.login(pg_temp.fx('frank'));
select is((select count(*) from public.post_images), 0::bigint, '4. another community''s member sees no pictures');
select is((select count(*) from storage.objects where bucket_id = 'post-images'), 0::bigint,
  '4. ...and cannot read any file');
select throws_ok(format($$ select * from public.create_post(%L, 'Hi', '[]'::jsonb) $$, pg_temp.fx('A')),
  '42501', null, '4. nor post in that community');

select pg_temp.login(pg_temp.fx('grace'));
select is((select count(*) from public.post_images), 0::bigint, '4. a pending member sees no pictures');

-- Hidden by a moderator: the pictures follow the post's visibility.
select pg_temp.login(pg_temp.fx('dave'));
update public.posts set status = 'hidden' where id = pg_temp.fx('p1');
select is((select count(*) from public.post_images where post_id = pg_temp.fx('p1')), 2::bigint, '4. moderators still see a hidden post''s pictures');
reset role;
select pg_temp.login(pg_temp.fx('bob'));
select is((select count(*) from storage.objects where bucket_id = 'post-images'
           and name = pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), 0::bigint,
  '4. a non-member cannot read a hidden post''s file');

-- =========================================================================
-- 5. Deleting files: own files, only while no post uses them
-- =========================================================================
select set_config('storage.allow_delete_query', 'true', true);
select pg_temp.login(pg_temp.fx('dave'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'post-images' and name like %L returning 1 $$,
  pg_temp.fx('A')::text || '/' || pg_temp.fx('carol')::text || '/%'), '5. nobody deletes someone else''s files');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'post-images' and name = %L returning 1 $$,
  pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), '5. a file a post uses cannot be deleted');
select isnt_empty(format($$ delete from storage.objects where bucket_id = 'post-images' and name = %L returning 1 $$,
  pg_temp.img('A', 'carol', '88888888-8888-4888-8888-888888888888.jpg')), '5. an unattached upload can be removed by its uploader');

-- =========================================================================
-- 6. Purge listing is for the service role only
-- =========================================================================
select throws_ok($$ select * from public.list_post_image_files_to_purge() $$, '42501', null,
  '6. clients cannot list files to purge');
reset role;
select pg_temp.upload(pg_temp.img('A', 'dave', 'aaaaaaaa-1111-4111-8111-111111111111.jpg'));
update storage.objects set created_at = now() - interval '2 days'
where bucket_id = 'post-images' and name like '%/aaaaaaaa-1111-4111-8111-111111111111.jpg';
set local role service_role;
select ok(pg_temp.img('A', 'dave', 'aaaaaaaa-1111-4111-8111-111111111111.jpg') in (select name from public.list_post_image_files_to_purge()),
  '6. an old unattached upload is listed for purging');
select ok(pg_temp.img('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg') not in (select name from public.list_post_image_files_to_purge(interval '1 hour')),
  '6. a file a post uses is never listed');
reset role;

select * from finish();
rollback;

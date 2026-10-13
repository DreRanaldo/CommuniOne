-- Design pass: stories (private bucket, own-folder uploads, 24h expiry, views, moderation, isolation, purge) and the hub / profile counts.
begin;
create extension if not exists pgtap with schema extensions;

select plan(59);

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
create function pg_temp.sp(p_community text, p_user text, p_file text) returns text language sql as $$
  select pg_temp.fx(p_community)::text || '/' || pg_temp.fx(p_user)::text || '/' || p_file
$$;
create function pg_temp.upload(p_name text) returns void language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values ('stories', p_name, '{"size": 1000, "mimetype": "image/jpeg"}');
end;
$$;
create function pg_temp.story_count(p_user text) returns bigint language sql security definer as $$
  select count(*) from public.stories where author_user_id = pg_temp.fx(p_user)
$$;
create function pg_temp.object_exists(p_name text) returns boolean language sql security definer as $$
  select exists (select 1 from storage.objects where bucket_id = 'stories' and name = p_name)
$$;
create function pg_temp.expire(p_story uuid) returns void language plpgsql security definer as $$
begin
  update public.stories set created_at = now() - interval '26 hours', expires_at = now() - interval '2 hours' where id = p_story;
end;
$$;

-- Storage blocks SQL deletes unless asked (the Storage API sets this); the policies still apply.
select set_config('storage.allow_delete_query', 'true', true);

select is((select public from storage.buckets where id = 'stories'), false, 'the stories bucket is private');

-- =========================================================================
-- 1. Upload: own folder of a community where you may post
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '1. a member uploads a story picture into their own folder');
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg')),
  '1. a second picture');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg')),
  '42501', null, '1. nobody uploads into someone else''s folder');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('B', 'carol', '44444444-4444-4444-8444-444444444444.jpg')),
  '42501', null, '1. nobody uploads into a community they do not belong to');
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.fx('A')::text || '/' || pg_temp.fx('carol')::text || '/../x.jpg'),
  '42501', null, '1. malformed paths are refused');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('A', 'grace', '55555555-5555-4555-8555-555555555555.jpg')),
  '42501', null, '1. a pending member cannot upload');
select pg_temp.login(pg_temp.fx('erin'));
select lives_ok(format($$ select pg_temp.upload(%L) $$, pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg')),
  '1. an admin uploads too');

-- =========================================================================
-- 2. create_story
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
insert into fx select 's1', id from public.create_story(pg_temp.fx('A'),
  pg_temp.sp('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg'), 1080, 1920, '  Garden day!  ',
  '99999999-0000-4000-8000-000000000001');
select results_eq(
  format($$ select community_id, author_user_id, caption, width, height from public.stories where id = %L $$, pg_temp.fx('s1')),
  format($$ values (%L::uuid, %L::uuid, 'Garden day!'::text, 1080, 1920) $$, pg_temp.fx('A'), pg_temp.fx('carol')),
  '2. a story belongs to its community and author; the caption is trimmed');
select ok((select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours'
           from public.stories where id = pg_temp.fx('s1')), '2. a story lasts 24 hours');
select is(
  (select id from public.create_story(pg_temp.fx('A'), pg_temp.sp('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg'),
     1080, 1920, null, '99999999-0000-4000-8000-000000000001')),
  pg_temp.fx('s1'), '2. a retried publish returns the first story');
select is(pg_temp.story_count('carol'), 1::bigint, '2. ...and creates no duplicate');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10) $$, pg_temp.fx('A'),
  pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg')),
  '42501', null, '2. someone else''s picture cannot be published');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10) $$, pg_temp.fx('A'),
  pg_temp.sp('A', 'carol', '66666666-6666-4666-8666-666666666666.jpg')),
  '22023', null, '2. a picture that was not uploaded is refused');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10) $$, pg_temp.fx('B'),
  pg_temp.sp('B', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '42501', null, '2. no stories in a community you do not belong to');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10) $$, pg_temp.fx('A'),
  pg_temp.sp('B', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '42501', null, '2. a picture from another community''s folder is refused');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10, %L) $$, pg_temp.fx('A'),
  pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg'), repeat('x', 201)),
  '22023', null, '2. captions are at most 200 characters');
select throws_ok(format($$ select public.create_story(%L, %L, 0, 10) $$, pg_temp.fx('A'),
  pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg')),
  '22023', null, '2. the picture size must be valid');
select throws_ok(format($$ select public.create_story(%L, %L, 10, 10) $$, pg_temp.fx('A'),
  pg_temp.sp('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')),
  '23505', null, '2. one picture, one story');
select throws_ok($$ insert into public.stories (community_id, author_user_id, storage_path, width, height)
                    values (pg_temp.fx('A'), pg_temp.fx('carol'), 'x', 1, 1) $$,
  '42501', null, '2. no direct inserts');
select throws_ok(format($$ update public.stories set expires_at = now() + interval '30 days' where id = %L $$, pg_temp.fx('s1')),
  '42501', null, '2. no direct updates (a story cannot be extended)');

select pg_temp.login(pg_temp.fx('erin'));
insert into fx select 's2', id from public.create_story(pg_temp.fx('A'),
  pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg'), 1080, 1350);

-- =========================================================================
-- 3. Who sees what
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select is((select count(*) from public.list_community_stories(pg_temp.fx('A'))), 2::bigint,
  '3. members see the community''s active stories');
select is((select count(*) from public.stories where community_id = pg_temp.fx('A')), 2::bigint,
  '3. ...also through the table (RLS)');
select is((select count(*) from storage.objects where bucket_id = 'stories'
           and name = pg_temp.sp('A', 'carol', '11111111-1111-4111-8111-111111111111.jpg')), 1::bigint,
  '3. ...and can read their pictures');
select is((select count(*) from storage.objects where bucket_id = 'stories'
           and name = pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg')), 0::bigint,
  '3. an unpublished upload is private to its uploader');
select pg_temp.login(pg_temp.fx('frank'));
select is((select count(*) from public.list_community_stories(pg_temp.fx('A'))), 0::bigint,
  '3. another community''s member sees nothing');
select is((select count(*) from public.stories), 0::bigint, '3. ...through the table either');
select is((select count(*) from storage.objects where bucket_id = 'stories'), 0::bigint, '3. ...nor any picture');
select pg_temp.login(pg_temp.fx('grace'));
select is((select count(*) from public.list_community_stories(pg_temp.fx('A'))), 0::bigint,
  '3. a pending member sees nothing');

-- =========================================================================
-- 4. Views
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select is(public.mark_story_viewed(pg_temp.fx('s1')), true, '4. a viewer marks a story seen');
select is(public.mark_story_viewed(pg_temp.fx('s1')), true, '4. ...again: no error, still one view');
select results_eq(
  format($$ select viewed_by_me, view_count from public.list_community_stories(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('s1')),
  $$ values (true, null::integer) $$,
  '4. the viewer sees it as seen, and no view count (not their story)');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select viewed_by_me, view_count from public.list_community_stories(%L) where id = %L $$, pg_temp.fx('A'), pg_temp.fx('s1')),
  $$ values (false, 1) $$,
  '4. the author gets the count');
select is((select count(*) from public.story_views), 0::bigint, '4. ...but not who saw it');
select is((select author_user_id from public.list_community_stories(pg_temp.fx('A')) limit 1), pg_temp.fx('carol'),
  '4. the caller''s own stories come first');
select pg_temp.login(pg_temp.fx('frank'));
select is(public.mark_story_viewed(pg_temp.fx('s1')), false, '4. a story you cannot see cannot be marked');
select throws_ok(format($$ insert into public.story_views (story_id, viewer_user_id) values (%L, %L) $$,
  pg_temp.fx('s1'), pg_temp.fx('frank')), '42501', null, '4. no direct view inserts');

-- =========================================================================
-- 5. Delete
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.delete_story(%L) $$, pg_temp.fx('s2')),
  '42501', null, '5. a member cannot delete someone else''s story');
select pg_temp.login(pg_temp.fx('frank'));
select is(public.delete_story(pg_temp.fx('s2')), false, '5. outsiders cannot even see it');
select pg_temp.login(pg_temp.fx('dave'));
select is(public.delete_story(pg_temp.fx('s2')), true, '5. a moderator deletes a story');
select is((select count(*) from public.list_community_stories(pg_temp.fx('A')) where id = pg_temp.fx('s2')), 0::bigint,
  '5. a deleted story disappears');
select is((select count(*) from storage.objects where bucket_id = 'stories'
           and name = pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg')), 0::bigint,
  '5. ...and its picture is unreadable');
select pg_temp.login(pg_temp.fx('erin'));
select is_empty(format($$ delete from storage.objects where bucket_id = 'stories' and name = %L returning 1 $$,
  pg_temp.sp('A', 'erin', '33333333-3333-4333-8333-333333333333.jpg')), '5. a used picture cannot be deleted by its uploader');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ delete from storage.objects where bucket_id = 'stories' and name = %L $$,
  pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg')), '5. an unused upload can be discarded');
select is(pg_temp.object_exists(pg_temp.sp('A', 'carol', '22222222-2222-4222-8222-222222222222.jpg')), false, '5. ...and is gone');

-- =========================================================================
-- 6. Expiry and purge
-- =========================================================================
reset role;
select pg_temp.expire(pg_temp.fx('s1'));
select pg_temp.login(pg_temp.fx('dave'));
select is((select count(*) from public.list_community_stories(pg_temp.fx('A'))), 0::bigint, '6. expired stories disappear');
select is((select count(*) from storage.objects where bucket_id = 'stories'), 0::bigint, '6. ...with their pictures');
select is(public.mark_story_viewed(pg_temp.fx('s1')), false, '6. ...and cannot be marked seen');
select pg_temp.login(pg_temp.fx('carol'));
select is((select count(*) from public.stories), 0::bigint, '6. even for their author');
select throws_ok($$ select * from public.list_story_files_to_purge() $$, '42501', null, '6. clients cannot list files to purge');
select throws_ok($$ select public.purge_expired_stories() $$, '42501', null, '6. ...or purge');
reset role;
set local role service_role;
select is((select count(*) from public.list_story_files_to_purge(interval '1 hour')), 1::bigint,
  '6. the purge job lists the expired story''s file');
reset role;

-- =========================================================================
-- 7. Rate limit
-- =========================================================================
select is((select max_count from private.rate_limit_rules where action = 'story.create'), 30, '7. at most 30 stories per hour');

-- =========================================================================
-- 8. community_stats and my_profile_stats
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select is((select member_count from public.community_stats(pg_temp.fx('A'))), 4, '8. members of A: alice, erin, dave, carol (not the pending one)');
select ok((select posts_today is not null and current_announcements is not null and active_alerts is not null
                  and upcoming_events is not null and document_count is not null
           from public.community_stats(pg_temp.fx('A'))), '8. a member gets every count they may see');
select pg_temp.login(pg_temp.fx('frank'));
select throws_ok(format($$ select * from public.community_stats(%L) $$, pg_temp.fx('A')),
  '42501', null, '8. no stats for a community you do not belong to');
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(format($$ select * from public.community_stats(%L) $$, pg_temp.fx('A')),
  '42501', null, '8. ...nor while pending');
select pg_temp.login(pg_temp.fx('alice'));
select is((select communities from public.my_profile_stats()), 2, '8. alice belongs to two communities');
select pg_temp.login(pg_temp.fx('grace'));
select is((select communities from public.my_profile_stats()), 0, '8. a pending membership does not count');

select * from finish();
rollback;

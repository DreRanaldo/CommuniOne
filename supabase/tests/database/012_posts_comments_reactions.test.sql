-- Stage 5: posts, comments and reactions: authorization, moderation, cross-tenant attacks, pagination.
begin;
create extension if not exists pgtap with schema extensions;

select plan(83);

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

-- Extra Community A member for "another plain member" checks.
insert into auth.users (id, email) values ('15151515-0000-4000-8000-000000000015', 'mia@example.test');
insert into auth.sessions (id, user_id) values ('15151515-0000-4000-8000-000000000015', '15151515-0000-4000-8000-000000000015');
insert into fx values ('mia', '15151515-0000-4000-8000-000000000015');
select pg_temp.add_member('A', 'mia', 'Member');

-- =========================================================================
-- Posts: creation
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Hello from Carol') returning id, author_user_id, status)
insert into fx select 'p_carol', id from i;
select results_eq(
  $$ select author_user_id, status, visibility from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values (pg_temp.fx('carol'), 'published', 'members') $$,
  '1. a member creates a post; author comes from the session'
);
select throws_ok(
  format($$ insert into public.posts (community_id, body, author_user_id) values (%L, 'spoof', %L) $$, pg_temp.fx('A'), pg_temp.fx('mia')),
  '42501', null, 'a member cannot post as another user (author_user_id not writable)'
);
select throws_ok(
  format($$ insert into public.posts (community_id, body, status) values (%L, 'sneaky', 'hidden') $$, pg_temp.fx('A')),
  '42501', null, 'clients cannot choose a post status on creation'
);
select throws_like(
  format($$ insert into public.posts (community_id, body) values (%L, 'intruder') $$, pg_temp.fx('B')),
  '%row-level security%', '2. a non-member cannot post in another community'
);
select throws_ok(
  format($$ insert into public.posts (community_id, body) values (%L, '   ') $$, pg_temp.fx('A')),
  '23514', null, 'blank posts are rejected'
);

select pg_temp.login(pg_temp.fx('grace'));
select throws_like(
  format($$ insert into public.posts (community_id, body) values (%L, 'pending hello') $$, pg_temp.fx('A')),
  '%row-level security%', 'a pending member cannot post'
);

select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('A'), 'Admin update') returning id)
insert into fx select 'p_erin', id from i;
select pg_temp.login(pg_temp.fx('frank'));
with i as (insert into public.posts (community_id, body) values (pg_temp.fx('B'), 'Frank in B') returning id)
insert into fx select 'p_frank', id from i;

-- =========================================================================
-- Posts: reading and tenant isolation
-- =========================================================================
select pg_temp.login(pg_temp.fx('mia'));
select results_eq(
  $$ select id from public.posts order by body $$,
  $$ values (pg_temp.fx('p_erin')), (pg_temp.fx('p_carol')) $$,
  '3. a member reads her community''s posts'
);
select pg_temp.login(pg_temp.fx('frank'));
select results_eq($$ select id from public.posts $$, $$ values (pg_temp.fx('p_frank')) $$, '4. a user sees only her own community''s posts');
select is_empty($$ select 1 from public.posts where id = pg_temp.fx('p_carol') $$, '4. ...even when requesting another community''s post by id');
select is_empty(
  format($$ select * from public.list_community_posts(%L) $$, pg_temp.fx('A')),
  '4. ...or listing another community''s feed by community id'
);

-- =========================================================================
-- Posts: editing
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
update public.posts set body = 'Hello from Carol (edited)' where id = pg_temp.fx('p_carol');
select results_eq(
  $$ select body, edited_at is not null from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values ('Hello from Carol (edited)', true) $$,
  '5. a user edits her own post and edited_at is stamped'
);
with u as (update public.posts set body = 'defaced' where id = pg_temp.fx('p_erin') returning 1)
select is(count(*)::int, 0, '6. a user cannot edit another user''s post') from u;
with u as (update public.posts set status = 'deleted' where id = pg_temp.fx('p_erin') returning 1)
select is(count(*)::int, 0, '6. a user cannot delete another user''s post') from u;
select throws_like(
  format($$ update public.posts set status = 'hidden' where id = %L $$, pg_temp.fx('p_carol')),
  '%not permitted%', 'an author without posts.moderate cannot hide posts'
);
select throws_ok(
  format($$ update public.posts set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('p_carol')),
  '42501', null, 'a post cannot be moved to another community'
);
select throws_ok(
  format($$ delete from public.posts where id = %L $$, pg_temp.fx('p_carol')),
  '42501', null, 'clients cannot hard-delete posts'
);

select pg_temp.login(pg_temp.fx('bob'));
with u as (update public.posts set status = 'hidden' where id = pg_temp.fx('p_carol') returning 1)
select is(count(*)::int, 0, 'the Owner of B cannot moderate posts in A') from u;

-- =========================================================================
-- Posts: moderation and hidden/deleted visibility
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ update public.posts set body = 'moderator words' where id = %L $$, pg_temp.fx('p_carol')),
  '%only edit your own%', 'moderators cannot rewrite other people''s posts'
);
update public.posts set status = 'hidden', moderation_reason = 'Off topic' where id = pg_temp.fx('p_carol');
select results_eq(
  $$ select status, moderated_by_user_id, moderation_reason from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values ('hidden', pg_temp.fx('dave'), 'Off topic') $$,
  '7. a moderator hides a post and the action is stamped'
);

select pg_temp.login(pg_temp.fx('mia'));
select is_empty($$ select 1 from public.posts where id = pg_temp.fx('p_carol') $$, '14. other members cannot see a hidden post');
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  $$ select status, moderation_reason from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values ('hidden', 'Off topic') $$,
  '14. the author still sees her hidden post and why'
);
select throws_like(
  format($$ update public.posts set body = 'sneaky fix' where id = %L $$, pg_temp.fx('p_carol')),
  '%only edit your own published%', '14. a hidden post cannot be edited by its author'
);
select throws_like(
  format($$ update public.posts set status = 'published' where id = %L $$, pg_temp.fx('p_carol')),
  '%not permitted%', '14. an author cannot un-hide her own post'
);

select pg_temp.login(pg_temp.fx('dave'));
update public.posts set status = 'published' where id = pg_temp.fx('p_carol');
select results_eq(
  $$ select status, moderation_reason from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values ('published', null::text) $$,
  '7. a moderator restores a hidden post and the moderation reason is cleared'
);

select pg_temp.login(pg_temp.fx('carol'));
update public.posts set status = 'deleted' where id = pg_temp.fx('p_carol');
select results_eq(
  $$ select status from public.posts where id = pg_temp.fx('p_carol') $$,
  $$ values ('deleted') $$,
  '14. an author soft-deletes her own post (and still sees it as deleted)'
);
select throws_like(
  format($$ update public.posts set status = 'published' where id = %L $$, pg_temp.fx('p_carol')),
  '%deleted posts cannot be modified%', '14. an author cannot restore a deleted post'
);
select pg_temp.login(pg_temp.fx('mia'));
select is_empty($$ select 1 from public.posts where id = pg_temp.fx('p_carol') $$, '14. a deleted post is invisible to members');
select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty($$ select 1 from public.posts where id = pg_temp.fx('p_carol') $$, '14. moderators can still see deleted posts (moderation record)');
select throws_like(
  format($$ update public.posts set status = 'published' where id = %L $$, pg_temp.fx('p_carol')),
  '%deleted posts cannot be modified%', '14. deleted is terminal, even for moderators'
);

-- =========================================================================
-- Comments
-- =========================================================================
select pg_temp.login(pg_temp.fx('mia'));
with i as (insert into public.comments (post_id, body) values (pg_temp.fx('p_erin'), 'Thanks Erin') returning id)
insert into fx select 'c_mia', id from i;
select results_eq(
  $$ select community_id, depth, author_user_id from public.comments where id = pg_temp.fx('c_mia') $$,
  $$ values (pg_temp.fx('A'), 0::smallint, pg_temp.fx('mia')) $$,
  '8. a member comments; community and depth are derived server-side'
);

select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.comments (post_id, parent_comment_id, body) values (pg_temp.fx('p_erin'), pg_temp.fx('c_mia'), 'Agreed!') returning id)
insert into fx select 'c_carol_reply', id from i;
select is((select depth from public.comments where id = pg_temp.fx('c_carol_reply')), 1::smallint, 'threaded replies record their depth');
select throws_ok(
  format($$ insert into public.comments (post_id, parent_comment_id, body) values (%L, %L, 'wrong thread') $$,
         pg_temp.fx('p_carol'), pg_temp.fx('c_mia')),
  null, null, 'a reply''s parent must belong to the same post'
);
select throws_ok(
  format($$ insert into public.comments (post_id, body) values (%L, 'on a deleted post') $$, pg_temp.fx('p_carol')),
  null, null, 'nobody can comment on a deleted post'
);
with u as (update public.comments set body = 'changed by Carol' where id = pg_temp.fx('c_mia') returning 1)
select is(count(*)::int, 0, '11. a user cannot edit another user''s comment') from u;
with u as (update public.comments set status = 'deleted' where id = pg_temp.fx('c_mia') returning 1)
select is(count(*)::int, 0, 'a user cannot delete another user''s comment') from u;

select pg_temp.login(pg_temp.fx('mia'));
update public.comments set body = 'Thanks Erin!' where id = pg_temp.fx('c_mia');
select results_eq(
  $$ select body, edited_at is not null from public.comments where id = pg_temp.fx('c_mia') $$,
  $$ values ('Thanks Erin!', true) $$,
  '10. a user edits her own comment'
);

select pg_temp.login(pg_temp.fx('frank'));
select throws_like(
  format($$ insert into public.comments (post_id, body) values (%L, 'from B') $$, pg_temp.fx('p_erin')),
  '%row-level security%', '9. a user cannot comment in another community'
);
select throws_ok(
  format($$ insert into public.comments (post_id, parent_comment_id, body) values (%L, %L, 'graft') $$,
         pg_temp.fx('p_frank'), pg_temp.fx('c_mia')),
  '23503', null, 'a comment in B cannot be attached to a parent in A'
);
select is_empty($$ select 1 from public.comments where post_id = pg_temp.fx('p_erin') $$, 'a user cannot read another community''s comments by post id');
select is_empty($$ select 1 from public.comments where id = pg_temp.fx('c_mia') $$, 'a user cannot read another community''s comment by comment id');
with u as (update public.comments set body = 'x' where id = pg_temp.fx('c_mia') returning 1)
select is(count(*)::int, 0, 'a user cannot edit another community''s comment') from u;

-- Comment moderation
select pg_temp.login(pg_temp.fx('dave'));
update public.comments set status = 'hidden', moderation_reason = 'Spam' where id = pg_temp.fx('c_carol_reply');
select is((select status from public.comments where id = pg_temp.fx('c_carol_reply')), 'hidden', 'a moderator hides a comment');
select pg_temp.login(pg_temp.fx('mia'));
select is_empty($$ select 1 from public.comments where id = pg_temp.fx('c_carol_reply') $$, 'a hidden comment is invisible to other members');
select pg_temp.login(pg_temp.fx('carol'));
select isnt_empty($$ select 1 from public.comments where id = pg_temp.fx('c_carol_reply') $$, 'the author still sees her hidden comment');
select pg_temp.login(pg_temp.fx('mia'));
select throws_ok(
  format($$ insert into public.comments (post_id, parent_comment_id, body) values (%L, %L, 'reply to hidden') $$,
         pg_temp.fx('p_erin'), pg_temp.fx('c_carol_reply')),
  null, null, 'nobody can reply to a hidden comment'
);
update public.comments set status = 'deleted' where id = pg_temp.fx('c_mia');
select is((select status from public.comments where id = pg_temp.fx('c_mia')), 'deleted', 'an author deletes her own comment');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.comments where id = pg_temp.fx('c_mia') $$, 'a deleted comment is invisible to other members');
select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty($$ select 1 from public.comments where id = pg_temp.fx('c_mia') $$, 'moderators still see deleted comments');

-- =========================================================================
-- Reactions
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with i as (insert into public.reactions (post_id, reaction_type) values (pg_temp.fx('p_erin'), 'like') returning id)
insert into fx select 'r_carol', id from i;
select is((select user_id from public.reactions where id = pg_temp.fx('r_carol')), pg_temp.fx('carol'), 'a member reacts to a post');
select throws_ok(
  format($$ insert into public.reactions (post_id, reaction_type) values (%L, 'love') $$, pg_temp.fx('p_erin')),
  '23505', null, '12. a second reaction by the same user on the same post is rejected'
);
update public.reactions set reaction_type = 'love' where id = pg_temp.fx('r_carol');
select is((select reaction_type from public.reactions where id = pg_temp.fx('r_carol')), 'love', 'a user changes her reaction type');
select throws_ok(
  format($$ insert into public.reactions (post_id, reaction_type) values (%L, 'angry') $$, pg_temp.fx('p_erin')),
  '23514', null, 'unknown reaction types are rejected'
);

select pg_temp.login(pg_temp.fx('mia'));
with i as (insert into public.reactions (post_id, reaction_type) values (pg_temp.fx('p_erin'), 'like') returning id)
insert into fx select 'r_mia', id from i;
with u as (update public.reactions set reaction_type = 'sad' where id = pg_temp.fx('r_carol') returning 1)
select is(count(*)::int, 0, '13. a user cannot change another user''s reaction') from u;
with d as (delete from public.reactions where id = pg_temp.fx('r_carol') returning 1)
select is(count(*)::int, 0, '13. a user cannot remove another user''s reaction') from d;
select throws_ok(
  format($$ insert into public.reactions (post_id, reaction_type, user_id) values (%L, 'like', %L) $$, pg_temp.fx('p_erin'), pg_temp.fx('carol')),
  '42501', null, '13. a user cannot react on behalf of another user'
);
select throws_ok(
  format($$ update public.reactions set post_id = %L where id = %L $$, pg_temp.fx('p_frank'), pg_temp.fx('r_mia')),
  '42501', null, 'a reaction cannot be moved to other content'
);

select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select reaction_type, reaction_count, reacted_by_me from public.get_reaction_summary(array[%L]::uuid[]) $$, pg_temp.fx('p_erin')),
  $$ values ('like', 1::bigint, false), ('love', 1::bigint, true) $$,
  'reaction counts per type, with the caller''s own choice'
);

-- Comment reactions (extensible target)
select pg_temp.login(pg_temp.fx('dave'));
with i as (insert into public.comments (post_id, body) values (pg_temp.fx('p_erin'), 'Moderator note') returning id)
insert into fx select 'c_dave', id from i;
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(
  format($$ insert into public.reactions (comment_id, reaction_type) values (%L, 'support') $$, pg_temp.fx('c_dave')),
  'a member reacts to a comment'
);
select throws_ok(
  format($$ insert into public.reactions (comment_id, reaction_type) values (%L, 'like') $$, pg_temp.fx('c_dave')),
  '23505', null, '12. one reaction per user per comment'
);
select throws_ok(
  format($$ insert into public.reactions (post_id, comment_id, reaction_type) values (%L, %L, 'like') $$, pg_temp.fx('p_erin'), pg_temp.fx('c_dave')),
  null, null, 'a reaction targets exactly one item'
);
reset role;
select throws_ok(
  format($$ insert into public.reactions (community_id, user_id, post_id, comment_id, reaction_type) values (%L, %L, %L, %L, 'like') $$,
         pg_temp.fx('A'), pg_temp.fx('erin'), pg_temp.fx('p_erin'), pg_temp.fx('c_dave')),
  '23514', null, 'the single-target rule is a table constraint'
);
insert into public.reactions (community_id, user_id, post_id, reaction_type)
values (pg_temp.fx('B'), pg_temp.fx('erin'), pg_temp.fx('p_erin'), 'like');
select is(
  (select community_id from public.reactions where user_id = pg_temp.fx('erin') and post_id = pg_temp.fx('p_erin')),
  pg_temp.fx('A'), 'a reaction''s community is always derived from its target, whatever the writer supplies'
);
select throws_ok(
  format($$ update public.reactions set community_id = %L where user_id = %L and post_id = %L $$,
         pg_temp.fx('B'), pg_temp.fx('erin'), pg_temp.fx('p_erin')),
  '42501', null, 'a reaction''s community can never be changed, even by trusted code'
);

-- Cross-community reactions
select pg_temp.login(pg_temp.fx('frank'));
select throws_like(
  format($$ insert into public.reactions (post_id, reaction_type) values (%L, 'like') $$, pg_temp.fx('p_erin')),
  '%row-level security%', 'a user cannot react to another community''s post'
);
select throws_like(
  format($$ insert into public.reactions (comment_id, reaction_type) values (%L, 'like') $$, pg_temp.fx('c_dave')),
  '%row-level security%', 'a user cannot react to another community''s comment'
);
select is_empty($$ select 1 from public.reactions where post_id = pg_temp.fx('p_erin') $$, 'a user cannot read another community''s reactions');
select is_empty(
  format($$ select * from public.get_reaction_summary(array[%L]::uuid[]) $$, pg_temp.fx('p_erin')),
  'reaction summaries reveal nothing across communities'
);

-- Reactions on hidden content
select pg_temp.login(pg_temp.fx('dave'));
update public.posts set status = 'hidden' where id = pg_temp.fx('p_erin');
select pg_temp.login(pg_temp.fx('carol'));
with d as (delete from public.reactions where id = pg_temp.fx('r_carol') returning 1)
select is(count(*)::int, 1, 'a user can always remove her own reaction, even after the post is hidden') from d;
select pg_temp.login(pg_temp.fx('dave'));
select throws_like(
  format($$ insert into public.reactions (post_id, reaction_type) values (%L, 'like') $$, pg_temp.fx('p_erin')),
  '%row-level security%', 'nobody can react to hidden content'
);
update public.posts set status = 'published' where id = pg_temp.fx('p_erin');

-- Suspended members lose all content access
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('mia@A');
select pg_temp.login(pg_temp.fx('mia'));
select is_empty($$ select 1 from public.posts $$, 'a suspended member cannot read posts');
select throws_like(
  format($$ insert into public.posts (community_id, body) values (%L, 'still here') $$, pg_temp.fx('A')),
  '%row-level security%', 'a suspended member cannot post'
);
with u as (update public.reactions set reaction_type = 'sad' where id = pg_temp.fx('r_mia') returning 1)
select is(count(*)::int, 0, 'a suspended member cannot change reactions') from u;

-- =========================================================================
-- 15. Pagination
-- =========================================================================
-- 25 posts inserted in ONE transaction share the same created_at, which is
-- exactly the case naive created_at-only cursors get wrong.
select pg_temp.login(pg_temp.fx('alice'));
insert into public.posts (community_id, body) select pg_temp.fx('A'), 'Bulk ' || i from generate_series(1, 25) as i;

create temp table pages (page int, id uuid, created_at timestamptz);
grant all on pages to public;
do $$
declare
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_page int := 0;
  v_count int;
begin
  loop
    v_page := v_page + 1;
    insert into pages
      select v_page, p.id, p.created_at
      from public.list_community_posts(pg_temp.fx('A'), 10, v_cursor_at, v_cursor_id) p;
    get diagnostics v_count = row_count;
    exit when v_count < 10 or v_page > 10;
    select created_at, id into v_cursor_at, v_cursor_id from pages where page = v_page order by created_at, id limit 1;
  end loop;
end;
$$;
select results_eq(
  $$ select page, count(*)::int from pages group by page order by page $$,
  $$ values (1, 10), (2, 10), (3, 6) $$,
  '15. 26 published posts paginate as 10 + 10 + 6'
);
select is((select count(distinct id)::int from pages), 26, '15. no post is duplicated or skipped across pages');
select set_eq(
  $$ select id from pages $$,
  $$ select id from public.posts where community_id = pg_temp.fx('A') and status = 'published' $$,
  '15. the pages contain exactly the published posts'
);
select is((select count(*)::int from public.list_community_posts(pg_temp.fx('A'), 1000)) <= 50, true, '15. page size never exceeds 50');
select throws_ok(
  format($$ select * from public.list_community_posts(%L, 10, now(), null) $$, pg_temp.fx('A')),
  '22023', null, '15. a cursor needs both created_at and id'
);
select is((select count(*)::int from public.list_community_posts(pg_temp.fx('A'), 10, null, null, 'deleted')), 1, 'Owners (posts.moderate) can list deleted posts');
select pg_temp.login(pg_temp.fx('erin'));
select ok(
  (select comment_count from public.list_community_posts(pg_temp.fx('A'), 50) where id = pg_temp.fx('p_erin')) = 1,
  'feed rows carry the count of visible published comments'
);
select pg_temp.login(pg_temp.fx('carol'));
select results_eq(
  format($$ select id from public.list_community_posts(%L, 10, null, null, 'deleted') $$, pg_temp.fx('A')),
  $$ values (pg_temp.fx('p_carol')) $$,
  'members see only their own deleted posts'
);

-- Comment pagination: 7 top-level comments + replies
select pg_temp.login(pg_temp.fx('carol'));
insert into public.comments (post_id, body) select pg_temp.fx('p_erin'), 'Bulk comment ' || i from generate_series(1, 7) as i;
select is(
  (select count(*)::int from public.list_post_comments(pg_temp.fx('p_erin'), null, 4)), 4,
  '15. comment pages respect the limit'
);
select is(
  (select count(*)::int from (
     select c.* from public.list_post_comments(pg_temp.fx('p_erin'), null, 100) c
   ) x), 8,
  'top-level comments visible to a member: 7 new + the moderator note (deleted/hidden excluded)'
);
select is(
  (select count(*)::int from public.list_post_comments(
     pg_temp.fx('p_erin'), null, 100,
     (select created_at from public.list_post_comments(pg_temp.fx('p_erin'), null, 4) order by created_at desc, id desc limit 1),
     (select id from public.list_post_comments(pg_temp.fx('p_erin'), null, 4) order by created_at desc, id desc limit 1))),
  4, '15. the second comment page continues after the cursor'
);

select * from finish();
rollback;

-- Stage 5 / Migration 11: posts, comments and reactions
--
-- Community-scoped social content. Every row carries community_id, and the
-- composite foreign keys below make it impossible (at the constraint level)
-- for a comment or reaction to point at content in another community.
--
-- Lifecycle (both posts and comments):
--   published --(moderator)--> hidden --(moderator)--> published
--   published | hidden --(author: *.delete_own | moderator)--> deleted
--   deleted is terminal. Nothing is hard-deleted by clients; content is
--   removed physically only when its author's account is deleted.
--
-- Authorization uses only the existing permission keys:
--   posts.view, posts.create, posts.edit_own, posts.delete_own, posts.moderate,
--   comments.create, comments.edit_own, comments.delete_own, comments.moderate
-- Reacting requires posts.view on visible, published content (no dedicated
-- reaction permission exists yet; see docs/features/posts.md).
--
-- Status transitions and edit rules are enforced by triggers because RLS
-- cannot compare OLD and NEW (same pattern as memberships, Stage 1).

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------
create table public.posts (
  id                   uuid primary key default gen_random_uuid(),
  community_id         uuid not null references public.communities (id) on delete restrict,
  -- Defaulted from the validated session; clients cannot supply it.
  author_user_id       uuid not null default private.current_active_user_id()
                       references public.profiles (id) on delete cascade,
  body                 text not null
                       check (char_length(btrim(body)) between 1 and 10000),
  status               text not null default 'published'
                       check (status in ('published', 'hidden', 'deleted')),
  -- Audience within the community. Only 'members' exists today; new values
  -- require new RLS rules, so the constraint rejects anything else.
  visibility           text not null default 'members'
                       check (visibility in ('members')),
  edited_at            timestamptz,
  moderated_by_user_id uuid references public.profiles (id) on delete set null,
  moderated_at         timestamptz,
  moderation_reason    text check (char_length(moderation_reason) <= 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Target for composite FKs from comments and reactions.
  constraint posts_id_community_key unique (id, community_id)
);

comment on table public.posts is 'Community posts. Soft-deleted via status; see docs/features/posts.md.';

-- Feed: newest first within a community, keyset (created_at, id).
create index posts_community_feed_idx on public.posts (community_id, created_at desc, id desc);
create index posts_author_idx on public.posts (author_user_id);

create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------
create table public.comments (
  id                   uuid primary key default gen_random_uuid(),
  -- Derived from the post by trigger; never supplied by clients.
  community_id         uuid not null,
  post_id              uuid not null,
  author_user_id       uuid not null default private.current_active_user_id()
                       references public.profiles (id) on delete cascade,
  parent_comment_id    uuid,
  -- 0 for top-level comments; derived from the parent by trigger.
  depth                smallint not null default 0 check (depth between 0 and 9),
  body                 text not null
                       check (char_length(btrim(body)) between 1 and 5000),
  status               text not null default 'published'
                       check (status in ('published', 'hidden', 'deleted')),
  edited_at            timestamptz,
  moderated_by_user_id uuid references public.profiles (id) on delete set null,
  moderated_at         timestamptz,
  moderation_reason    text check (char_length(moderation_reason) <= 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint comments_id_post_key unique (id, post_id),
  constraint comments_id_community_key unique (id, community_id),
  constraint comments_not_own_parent check (parent_comment_id is distinct from id),
  -- The post must be in the same community as the comment.
  constraint comments_post_fk
    foreign key (post_id, community_id)
    references public.posts (id, community_id) on delete cascade,
  -- The parent must be a comment on the SAME post. If the parent is removed
  -- (its author's account is deleted), replies become top-level instead of
  -- disappearing with it.
  constraint comments_parent_fk
    foreign key (parent_comment_id, post_id)
    references public.comments (id, post_id) on delete set null (parent_comment_id)
);

comment on table public.comments is 'Threaded comments on posts. Soft-deleted via status.';

-- Top-level comments of a post / replies of a comment, oldest first (keyset).
create index comments_post_thread_idx on public.comments (post_id, created_at, id);
create index comments_parent_thread_idx on public.comments (parent_comment_id, created_at, id)
  where parent_comment_id is not null;
create index comments_author_idx on public.comments (author_user_id);

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function private.set_updated_at();

-- Derive community_id from the post and depth from the parent. Runs as the
-- invoker: if the caller cannot see the post / parent, the lookup finds
-- nothing and the insert fails.
create or replace function private.prepare_comment_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_depth smallint;
begin
  select p.community_id into new.community_id
  from public.posts p where p.id = new.post_id;

  if new.parent_comment_id is null then
    new.depth := 0;
  else
    select c.depth into v_parent_depth
    from public.comments c
    where c.id = new.parent_comment_id and c.post_id = new.post_id;
    if v_parent_depth is null then
      raise exception 'parent comment not found on this post' using errcode = '23503';
    end if;
    new.depth := v_parent_depth + 1;
  end if;
  return new;
end;
$$;

revoke all on function private.prepare_comment_insert() from public;

create trigger comments_prepare_insert
  before insert on public.comments
  for each row execute function private.prepare_comment_insert();

-- ---------------------------------------------------------------------------
-- reactions
-- ---------------------------------------------------------------------------
-- One table for every reactable content type. Exactly one target column is
-- set. Adding a new content type = new nullable target column + composite FK
-- + partial unique index + an arm in private.can_react_to().
create table public.reactions (
  id            uuid primary key default gen_random_uuid(),
  community_id  uuid not null,
  user_id       uuid not null default private.current_active_user_id()
                references public.profiles (id) on delete cascade,
  post_id       uuid,
  comment_id    uuid,
  reaction_type text not null
                check (reaction_type in ('like', 'love', 'celebrate', 'support', 'laugh', 'sad')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint reactions_single_target check (num_nonnulls(post_id, comment_id) = 1),
  constraint reactions_post_fk
    foreign key (post_id, community_id)
    references public.posts (id, community_id) on delete cascade,
  constraint reactions_comment_fk
    foreign key (comment_id, community_id)
    references public.comments (id, community_id) on delete cascade
);

comment on table public.reactions is
  'One reaction per user per content item (change it by updating reaction_type).';

-- Business rule: one reaction per user per item. These also serve
-- "reactions by post / comment" lookups (leading column).
create unique index reactions_one_per_user_post on public.reactions (post_id, user_id) where post_id is not null;
create unique index reactions_one_per_user_comment on public.reactions (comment_id, user_id) where comment_id is not null;
create index reactions_user_idx on public.reactions (user_id);

create trigger reactions_set_updated_at
  before update on public.reactions
  for each row execute function private.set_updated_at();

create or replace function private.prepare_reaction_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.post_id is not null then
    select p.community_id into new.community_id from public.posts p where p.id = new.post_id;
  elsif new.comment_id is not null then
    select c.community_id into new.community_id from public.comments c where c.id = new.comment_id;
  end if;
  return new;
end;
$$;

revoke all on function private.prepare_reaction_insert() from public;

create trigger reactions_prepare_insert
  before insert on public.reactions
  for each row execute function private.prepare_reaction_insert();

-- ---------------------------------------------------------------------------
-- Visibility helpers (SECURITY DEFINER: avoid RLS recursion between posts,
-- comments and reactions; caller identity from the validated session only)
-- ---------------------------------------------------------------------------
-- published: posts.view
-- hidden / deleted: posts.moderate, or the author (with posts.view).
-- Authors keep seeing their own hidden/deleted posts (with the status and
-- moderation reason) so they know what happened. This is also required by
-- Postgres: the row produced by an UPDATE must remain visible to the user
-- making it, so an author could not soft-delete otherwise.
create or replace function private.can_view_post_row(p_community_id uuid, p_author_user_id uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_status
    when 'published' then public.has_community_permission(p_community_id, 'posts.view')
    else
      public.has_community_permission(p_community_id, 'posts.moderate')
      or (p_author_user_id = (select private.current_active_user_id())
          and public.has_community_permission(p_community_id, 'posts.view'))
  end;
$$;

create or replace function private.can_view_post(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.can_view_post_row(p.community_id, p.author_user_id, p.status)
    from public.posts p where p.id = p_post_id
  ), false);
$$;

-- A comment is visible only if its post is visible, and then:
-- published: yes | hidden / deleted: comments.moderate or the author
create or replace function private.can_view_comment_row(
  p_community_id uuid, p_post_id uuid, p_author_user_id uuid, p_status text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_post(p_post_id) and case p_status
    when 'published' then true
    else
      public.has_community_permission(p_community_id, 'comments.moderate')
      or p_author_user_id = (select private.current_active_user_id())
  end;
$$;

create or replace function private.can_view_comment(p_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.can_view_comment_row(c.community_id, c.post_id, c.author_user_id, c.status)
    from public.comments c where c.id = p_comment_id
  ), false);
$$;

-- New comments: the post must be published and visible, the caller needs
-- comments.create, and a parent (if any) must be a published comment on the
-- same post.
create or replace function private.can_comment_on(p_post_id uuid, p_parent_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.status = 'published'
      and public.has_community_permission(p.community_id, 'posts.view')
      and public.has_community_permission(p.community_id, 'comments.create')
  )
  and (
    p_parent_comment_id is null
    or exists (
      select 1 from public.comments c
      where c.id = p_parent_comment_id
        and c.post_id = p_post_id
        and c.status = 'published'
    )
  );
$$;

-- Reactions: the target must be published, visible, and the caller needs
-- posts.view in its community.
create or replace function private.can_react_to(p_post_id uuid, p_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_post_id is not null and p_comment_id is null then exists (
      select 1 from public.posts p
      where p.id = p_post_id and p.status = 'published'
        and public.has_community_permission(p.community_id, 'posts.view'))
    when p_comment_id is not null and p_post_id is null then exists (
      select 1 from public.comments c
      join public.posts p on p.id = c.post_id
      where c.id = p_comment_id and c.status = 'published' and p.status = 'published'
        and public.has_community_permission(c.community_id, 'posts.view'))
    else false
  end;
$$;

revoke all on function private.can_view_post_row(uuid, uuid, text)            from public, anon, authenticated;
revoke all on function private.can_view_post(uuid)                            from public, anon, authenticated;
revoke all on function private.can_view_comment_row(uuid, uuid, uuid, text)   from public, anon, authenticated;
revoke all on function private.can_view_comment(uuid)                         from public, anon, authenticated;
revoke all on function private.can_comment_on(uuid, uuid)                     from public, anon, authenticated;
revoke all on function private.can_react_to(uuid, uuid)                       from public, anon, authenticated;
grant execute on function private.can_view_post_row(uuid, uuid, text)          to authenticated;
grant execute on function private.can_view_post(uuid)                          to authenticated;
grant execute on function private.can_view_comment_row(uuid, uuid, uuid, text) to authenticated;
grant execute on function private.can_view_comment(uuid)                       to authenticated;
grant execute on function private.can_comment_on(uuid, uuid)                   to authenticated;
grant execute on function private.can_react_to(uuid, uuid)                     to authenticated;

-- ---------------------------------------------------------------------------
-- Edit / status-transition enforcement
-- ---------------------------------------------------------------------------
-- Shared rules for posts and comments (p_kind = 'posts' | 'comments'):
--   * community, post, parent, author and created_at are immutable
--   * deleted content cannot be changed at all
--   * body: only the author, only while published, with <kind>.edit_own;
--     sets edited_at. Moderators never rewrite other people's words.
--   * status:
--       author  published|hidden -> deleted         <kind>.delete_own
--       moderator published <-> hidden, -> deleted  <kind>.moderate
--         (stamps moderated_by_user_id / moderated_at)
--   * moderation_reason: moderators only; cleared when hidden content is
--     restored (unless a new reason is supplied in the same update)
-- Enforced for client roles only (service_role / migrations are trusted).
create or replace function private.enforce_content_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind      text := tg_argv[0];
  v_me        uuid;
  v_is_author boolean;
  v_can_mod   boolean;
begin
  if new.community_id is distinct from old.community_id
     or new.author_user_id is distinct from old.author_user_id
     or new.created_at is distinct from old.created_at then
    raise exception '% community, author and created_at are immutable', v_kind using errcode = '42501';
  end if;
  if v_kind = 'comments' and (
       (to_jsonb(new) ->> 'post_id') is distinct from (to_jsonb(old) ->> 'post_id')
       or ((to_jsonb(new) ->> 'parent_comment_id') is distinct from (to_jsonb(old) ->> 'parent_comment_id')
           and (to_jsonb(new) ->> 'parent_comment_id') is not null)) then
    -- (parent may only become NULL, via the parent FK's ON DELETE SET NULL)
    raise exception 'comment post and parent are immutable' using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  v_me        := private.current_active_user_id();
  v_is_author := old.author_user_id = v_me;
  v_can_mod   := public.has_community_permission(old.community_id, v_kind || '.moderate');

  if old.status = 'deleted' then
    raise exception 'deleted % cannot be modified', v_kind using errcode = '42501';
  end if;

  if new.body is distinct from old.body then
    if not (v_is_author
            and old.status = 'published' and new.status = 'published'
            and public.has_community_permission(old.community_id, v_kind || '.edit_own')) then
      raise exception 'you can only edit your own published %', v_kind using errcode = '42501';
    end if;
    new.edited_at := now();
  end if;

  if new.status is distinct from old.status then
    if v_is_author and new.status = 'deleted'
       and public.has_community_permission(old.community_id, v_kind || '.delete_own') then
      null; -- author deletes own content
    elsif v_can_mod and (
            (old.status = 'published' and new.status = 'hidden')
         or (old.status = 'hidden' and new.status = 'published')
         or new.status = 'deleted') then
      new.moderated_by_user_id := v_me;
      new.moderated_at := now();
      -- Restoring hidden content clears the (moderator-facing) reason so it
      -- is not shown to every member, unless a new reason is given.
      if new.status = 'published' and new.moderation_reason is not distinct from old.moderation_reason then
        new.moderation_reason := null;
      end if;
    else
      raise exception 'not permitted: % status % -> %', v_kind, old.status, new.status using errcode = '42501';
    end if;
  end if;

  if new.moderation_reason is distinct from old.moderation_reason and not v_can_mod then
    raise exception 'only moderators can set a moderation reason' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_content_update() from public, anon, authenticated;

create trigger posts_enforce_update
  before update on public.posts
  for each row execute function private.enforce_content_update('posts');

create trigger comments_enforce_update
  before update on public.comments
  for each row execute function private.enforce_content_update('comments');

create or replace function private.enforce_reaction_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.community_id is distinct from old.community_id
     or new.post_id is distinct from old.post_id
     or new.comment_id is distinct from old.comment_id then
    raise exception 'reaction owner and target are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_reaction_update() from public, anon, authenticated;

create trigger reactions_enforce_update
  before update on public.reactions
  for each row execute function private.enforce_reaction_update();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.posts, public.comments, public.reactions from public, anon, authenticated;
grant all on table public.posts, public.comments, public.reactions to service_role;

alter table public.posts     enable row level security;
alter table public.comments  enable row level security;
alter table public.reactions enable row level security;

-- posts: no client DELETE (soft delete via status). author_user_id, status,
-- visibility, community changes and moderation stamps are not grantable.
grant select on public.posts to authenticated;
grant insert (community_id, body) on public.posts to authenticated;
grant update (body, status, moderation_reason) on public.posts to authenticated;

create policy posts_select_visible on public.posts
  for select to authenticated
  using (private.can_view_post_row(community_id, author_user_id, status));

create policy posts_insert_member on public.posts
  for insert to authenticated
  with check (
    author_user_id = (select private.current_active_user_id())
    and status = 'published'
    and public.has_community_permission(community_id, 'posts.create')
  );

create policy posts_update_author_or_moderator on public.posts
  for update to authenticated
  using (
    (author_user_id = (select private.current_active_user_id())
      and (public.has_community_permission(community_id, 'posts.edit_own')
        or public.has_community_permission(community_id, 'posts.delete_own')))
    or public.has_community_permission(community_id, 'posts.moderate')
  )
  with check (
    (author_user_id = (select private.current_active_user_id())
      and (public.has_community_permission(community_id, 'posts.edit_own')
        or public.has_community_permission(community_id, 'posts.delete_own')))
    or public.has_community_permission(community_id, 'posts.moderate')
  );

-- comments
grant select on public.comments to authenticated;
grant insert (post_id, parent_comment_id, body) on public.comments to authenticated;
grant update (body, status, moderation_reason) on public.comments to authenticated;

create policy comments_select_visible on public.comments
  for select to authenticated
  using (private.can_view_comment_row(community_id, post_id, author_user_id, status));

create policy comments_insert_member on public.comments
  for insert to authenticated
  with check (
    author_user_id = (select private.current_active_user_id())
    and status = 'published'
    and private.can_comment_on(post_id, parent_comment_id)
  );

create policy comments_update_author_or_moderator on public.comments
  for update to authenticated
  using (
    (author_user_id = (select private.current_active_user_id())
      and (public.has_community_permission(community_id, 'comments.edit_own')
        or public.has_community_permission(community_id, 'comments.delete_own')))
    or public.has_community_permission(community_id, 'comments.moderate')
  )
  with check (
    (author_user_id = (select private.current_active_user_id())
      and (public.has_community_permission(community_id, 'comments.edit_own')
        or public.has_community_permission(community_id, 'comments.delete_own')))
    or public.has_community_permission(community_id, 'comments.moderate')
  );

-- reactions: users manage only their own.
grant select on public.reactions to authenticated;
grant insert (post_id, comment_id, reaction_type) on public.reactions to authenticated;
grant update (reaction_type) on public.reactions to authenticated;
grant delete on public.reactions to authenticated;

-- Visible when the target is visible, and your own reactions always (so
-- you can remove a reaction from content that was hidden afterwards; DELETE
-- requires the row to be visible).
create policy reactions_select_own_or_visible_target on public.reactions
  for select to authenticated
  using (
    user_id = (select private.current_active_user_id())
    or case when post_id is not null then private.can_view_post(post_id)
            else private.can_view_comment(comment_id) end
  );

create policy reactions_insert_own on public.reactions
  for insert to authenticated
  with check (
    user_id = (select private.current_active_user_id())
    and private.can_react_to(post_id, comment_id)
  );

create policy reactions_update_own on public.reactions
  for update to authenticated
  using (user_id = (select private.current_active_user_id()) and private.can_react_to(post_id, comment_id))
  with check (user_id = (select private.current_active_user_id()) and private.can_react_to(post_id, comment_id));

-- Removing your own reaction is always allowed while you have an active
-- account, even if the content was hidden afterwards.
create policy reactions_delete_own on public.reactions
  for delete to authenticated
  using (user_id = (select private.current_active_user_id()));

-- ---------------------------------------------------------------------------
-- Read API: cursor-paginated lists and reaction summaries
-- ---------------------------------------------------------------------------
-- All three are SECURITY INVOKER: they add no privileges, every row they
-- read is filtered by the RLS policies above.

-- Community feed, newest first. Pass the last row's (created_at, id) as the
-- cursor to get the next page. p_status lets moderators list hidden or
-- deleted posts; members simply get no rows for those statuses.
create or replace function public.list_community_posts(
  p_community_id      uuid,
  p_limit             integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id         uuid default null,
  p_status            text default 'published'
)
returns table (
  id                  uuid,
  community_id        uuid,
  author_user_id      uuid,
  author_display_name text,
  author_avatar_url   text,
  body                text,
  status              text,
  visibility          text,
  edited_at           timestamptz,
  moderation_reason   text,
  created_at          timestamptz,
  updated_at          timestamptz,
  comment_count       bigint,
  reaction_count      bigint,
  my_reaction_type    text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_created_at and p_cursor_id' using errcode = '22023';
  end if;

  return query
  select
    p.id, p.community_id, p.author_user_id, pr.display_name, pr.avatar_url,
    p.body, p.status, p.visibility, p.edited_at, p.moderation_reason, p.created_at, p.updated_at,
    (select count(*) from public.comments c where c.post_id = p.id and c.status = 'published'),
    (select count(*) from public.reactions r where r.post_id = p.id),
    (select r.reaction_type from public.reactions r
      where r.post_id = p.id and r.user_id = (select private.current_active_user_id()))
  from public.posts p
  left join public.profiles pr on pr.id = p.author_user_id
  where p.community_id = p_community_id
    and p.status = p_status
    and (p_cursor_created_at is null or (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- Comments of a post, oldest first. p_parent_comment_id NULL = top-level
-- comments; otherwise the direct replies of that comment.
create or replace function public.list_post_comments(
  p_post_id           uuid,
  p_parent_comment_id uuid default null,
  p_limit             integer default 50,
  p_cursor_created_at timestamptz default null,
  p_cursor_id         uuid default null
)
returns table (
  id                  uuid,
  post_id             uuid,
  parent_comment_id   uuid,
  depth               smallint,
  author_user_id      uuid,
  author_display_name text,
  author_avatar_url   text,
  body                text,
  status              text,
  edited_at           timestamptz,
  created_at          timestamptz,
  reply_count         bigint,
  reaction_count      bigint,
  my_reaction_type    text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor requires both p_cursor_created_at and p_cursor_id' using errcode = '22023';
  end if;

  return query
  select
    c.id, c.post_id, c.parent_comment_id, c.depth, c.author_user_id, pr.display_name, pr.avatar_url,
    c.body, c.status, c.edited_at, c.created_at,
    (select count(*) from public.comments r where r.parent_comment_id = c.id and r.status = 'published'),
    (select count(*) from public.reactions x where x.comment_id = c.id),
    (select x.reaction_type from public.reactions x
      where x.comment_id = c.id and x.user_id = (select private.current_active_user_id()))
  from public.comments c
  left join public.profiles pr on pr.id = c.author_user_id
  where c.post_id = p_post_id
    and c.parent_comment_id is not distinct from p_parent_comment_id
    and (p_cursor_created_at is null or (c.created_at, c.id) > (p_cursor_created_at, p_cursor_id))
  order by c.created_at, c.id
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

-- Reaction counts per type for up to 100 posts and 100 comments at once,
-- plus whether the caller chose each type. Only visible reactions count.
create or replace function public.get_reaction_summary(
  p_post_ids    uuid[] default '{}',
  p_comment_ids uuid[] default '{}'
)
returns table (
  post_id        uuid,
  comment_id     uuid,
  reaction_type  text,
  reaction_count bigint,
  reacted_by_me  boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_post_ids), 0) > 100 or coalesce(cardinality(p_comment_ids), 0) > 100 then
    raise exception 'at most 100 post ids and 100 comment ids per call' using errcode = '22023';
  end if;

  return query
  select r.post_id, r.comment_id, r.reaction_type, count(*),
         bool_or(r.user_id = (select private.current_active_user_id()))
  from public.reactions r
  where r.post_id = any (coalesce(p_post_ids, '{}'))
     or r.comment_id = any (coalesce(p_comment_ids, '{}'))
  group by r.post_id, r.comment_id, r.reaction_type
  order by r.post_id, r.comment_id, r.reaction_type;
end;
$$;

revoke all on function public.list_community_posts(uuid, integer, timestamptz, uuid, text) from public, anon, authenticated;
revoke all on function public.list_post_comments(uuid, uuid, integer, timestamptz, uuid)  from public, anon, authenticated;
revoke all on function public.get_reaction_summary(uuid[], uuid[])                        from public, anon, authenticated;
grant execute on function public.list_community_posts(uuid, integer, timestamptz, uuid, text) to authenticated;
grant execute on function public.list_post_comments(uuid, uuid, integer, timestamptz, uuid)  to authenticated;
grant execute on function public.get_reaction_summary(uuid[], uuid[])                        to authenticated;

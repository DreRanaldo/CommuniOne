# Posts, Comments and Reactions (Stage 5)

Community-scoped social content. Every rule here is enforced in Postgres (RLS,
column grants, triggers and constraints). Client checks are cosmetic.

- **Migration:** `supabase/migrations/20261011001100_posts_comments_reactions.sql`
- **Tests:**
  - `supabase/tests/database/012_posts_comments_reactions.test.sql` (pgTAP, 83)
  - `tests/integration/posts.test.mjs` (end to end through the Data API)

## Data model

```
communities ─1:N─ posts ─1:N─ comments ─┐ (parent_comment_id → comments, same post)
                    │            │      ┘
                    └──── reactions ────┘   (exactly one of post_id / comment_id)
```

| Table | Key columns | Notes |
|---|---|---|
| `posts` | `community_id`, `author_user_id`, `body` (1–10 000 chars), `status`, `visibility`, `edited_at`, `moderated_by_user_id`, `moderated_at`, `moderation_reason` | `author_user_id` defaults to the validated session user and cannot be supplied by clients |
| `comments` | `community_id` (derived), `post_id`, `author_user_id`, `parent_comment_id`, `depth` (derived, 0–9), `body` (1–5 000), `status`, moderation columns | Threaded through `parent_comment_id` |
| `reactions` | `community_id` (derived), `user_id`, `post_id` **or** `comment_id`, `reaction_type` | One reaction per user per item |

**Tenant integrity is enforced by constraints, not just policies:**

- `comments (post_id, community_id)` → `posts (id, community_id)`;
- `comments (parent_comment_id, post_id)` → `comments (id, post_id)`, so a parent must be on the **same post**;
- `reactions (post_id | comment_id, community_id)` → the target's `(id, community_id)`.

`community_id` on comments and reactions is always derived from the target by a
trigger. Clients cannot write it, and whatever trusted code supplies is
overwritten. It cannot be changed afterwards, even by the service role.

## Lifecycle

```
            moderator                       author (*.delete_own) or moderator
published ───────────► hidden               published | hidden ──────────► deleted (terminal)
          ◄───────────
            moderator
```

| Action | Who | Effect |
|---|---|---|
| Create | `posts.create` / `comments.create` | Always `published`. Status and author cannot be chosen. |
| Edit body | author with `posts.edit_own` / `comments.edit_own`, only while `published` | Sets `edited_at` |
| Delete | author with `*.delete_own`, or a moderator | `status = 'deleted'` (soft delete). Body is kept as a moderation record. |
| Hide / restore | moderator (`posts.moderate` / `comments.moderate`) | Stamps `moderated_by_user_id` and `moderated_at`. Restoring clears `moderation_reason` unless a new one is given. |
| Set `moderation_reason` | moderators only | Visible to the author on their hidden content |
| Change a deleted item | nobody | `42501` |
| Hard delete | nobody (no client DELETE privilege) | Content is physically removed only when its author's account is deleted (cascade) |

**Moderators change status, never words:** a moderator cannot edit another
user's body text. `community_id`, `author_user_id`, `post_id`,
`parent_comment_id` and `created_at` are immutable.

Comments additionally:

- can be added only to **published, visible** posts;
- can reply only to a **published** parent comment on the same post;
- can be nested up to 10 levels (`depth` 0–9);
- if a parent comment is physically removed (its author deleted their account),
  its replies become top-level instead of disappearing.

## Visibility (RLS)

| Content | Visible to |
|---|---|
| published post | members with `posts.view` (active membership, active community, live session, active account) |
| hidden or deleted post | `posts.moderate`, or **its author** (with the status and moderation reason) |
| published comment | anyone who can see the post |
| hidden or deleted comment | anyone who can see the post *and* has `comments.moderate`, or the comment's author |
| reaction | anyone who can see its target, and always the reaction's own user |

Authors keep seeing their own hidden and deleted content so they understand what
happened. This is also required by Postgres, because the row produced by an
UPDATE must stay visible to the user who made it.

**Cross-tenant attacks are refused** whichever identifier is changed:

| Identifier changed | Result |
|---|---|
| post id | another community's post is not returned, and updates affect 0 rows |
| comment id | another community's comment is not returned |
| community id | inserting a post into a community you don't belong to fails with `42501`, and listing its feed returns `[]` |
| parent comment id | using a parent from another post or community fails |
| user id (author or reaction owner) | the column is not writable (`42501`), and policies compare with the session user |

All of these are tested at both the database and the API level.

## Reactions

- Types: `like`, `love`, `celebrate`, `support`, `laugh`, `sad`.
- **One reaction per user per item**, enforced by partial unique indexes
  (`23505`). To change a reaction, update its `reaction_type`.
- To add a reaction or change its type, the target must be published and visible,
  and the user needs `posts.view`. There is no dedicated reaction permission yet;
  if one is needed, add `reactions.create` in a migration.
- Users can update or remove **only their own** reactions. Removal works even
  after the content has been hidden.
- Extending to new content types: add a nullable target column, a composite FK,
  a partial unique index and an arm in `private.can_react_to()`.

## Permissions used

| Permission | Grants |
|---|---|
| `posts.view` | read published posts and their published comments; react |
| `posts.create` | create posts |
| `posts.edit_own` / `posts.delete_own` | edit or delete your own posts |
| `posts.moderate` | hide, restore and delete any post; see hidden and deleted posts |
| `comments.create` | comment on visible published posts |
| `comments.edit_own` / `comments.delete_own` | edit or delete your own comments |
| `comments.moderate` | hide, restore and delete any comment; see hidden and deleted comments |

With the default roles, Members can view, create, edit and delete their own
content. Moderators, Admins and Owners can also moderate. Content moderation
does **not** apply the membership "coverage" rule: a Moderator can hide an
Admin's post. An Admin can restore it, and can demote the Moderator if needed.

## API

```ts
// Create
await supabase.from('posts').insert({ community_id, body }).select().single();
await supabase.from('comments').insert({ post_id, parent_comment_id /* optional */, body }).select().single();
await supabase.from('reactions').insert({ post_id /* or comment_id */, reaction_type: 'like' });

// Read one post (with its author's profile)
await supabase.from('posts').select('*, profiles!posts_author_user_id_fkey(display_name, avatar_url)').eq('id', postId).single();

// Edit / delete own content, moderate
await supabase.from('posts').update({ body }).eq('id', postId);
await supabase.from('posts').update({ status: 'deleted' }).eq('id', postId);
await supabase.from('posts').update({ status: 'hidden', moderation_reason: 'Off topic' }).eq('id', postId); // moderators
await supabase.from('reactions').update({ reaction_type: 'love' }).eq('id', reactionId);
await supabase.from('reactions').delete().eq('id', reactionId);

// Reaction counts for up to 100 posts and 100 comments
await supabase.rpc('get_reaction_summary', { p_post_ids: [...], p_comment_ids: [...] });
// → [{ post_id, comment_id, reaction_type, reaction_count, reacted_by_me }]
```

## Pagination

Lists use **keyset (cursor) pagination** on `(created_at, id)`. Rows with
identical timestamps (for example, created in one transaction) are never skipped
or duplicated.

```ts
// Feed, newest first
const page1 = await supabase.rpc('list_community_posts', { p_community_id, p_limit: 20 });
const last = page1.data.at(-1);
const page2 = await supabase.rpc('list_community_posts', {
  p_community_id, p_limit: 20, p_cursor_created_at: last.created_at, p_cursor_id: last.id,
});
// Moderators: p_status: 'hidden' | 'deleted'. Members get only their own such posts.

// Comments, oldest first: top-level comments, or the replies of one comment
await supabase.rpc('list_post_comments', { p_post_id, p_limit: 50 });
await supabase.rpc('list_post_comments', { p_post_id, p_parent_comment_id: commentId });
```

| Function | Default page | Maximum page | Order | Extra columns |
|---|---|---|---|---|
| `list_community_posts` | 20 | 50 | newest first | author name and avatar, published comment count, reaction count, `my_reaction_type` |
| `list_post_comments` | 50 | 100 | oldest first | author, `reply_count`, `reaction_count`, `my_reaction_type` |

- Both functions are `SECURITY INVOKER`: they add no privileges, and every row
  passes through RLS.
- Passing only half a cursor is rejected (`22023`).
- Deleted or hidden comments are not returned to members. Clients should render
  replies whose parent is missing under a "comment removed" placeholder.

Supporting indexes:

- `posts (community_id, created_at desc, id desc)`
- `comments (post_id, created_at, id)`
- `comments (parent_comment_id, created_at, id)`
- `reactions (post_id, user_id)`, `reactions (comment_id, user_id)`, `reactions (user_id)`
- author indexes on posts and comments (for account-deletion cascades)

## Known limitations

- **Deleted bodies are kept** for moderation. They are physically removed only
  on account deletion. There is no purge job yet.
- **No rate limiting** on posting, commenting or reacting.
- **No edit history,** only `edited_at`.
- **Realtime is not enabled** for these tables.
- **Account deletion cascades** to the user's posts, including other users'
  comments on those posts.

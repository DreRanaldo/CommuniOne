# Community Feed (RN-07)

The posts feed of the current community in the mobile app, built on the
existing posts backend (Stage 5 schema and RLS, Stage 12 service layer).

- **Screens:** `apps/mobile/src/features/feed/screens/`
  - `FeedScreen`: the list, with filters
  - `PostEditorScreen`: write or edit a post
- **Data:** `apps/mobile/src/features/feed/useFeed.ts`
- **Card:** `apps/mobile/src/features/feed/components/PostCard.tsx` (also used in compact form on the community home)
- **Permissions (display only):** `apps/mobile/src/features/communities/useCommunityPermissions.ts`
- **Backend:** no new migration. It uses `list_community_posts()`, the `posts`
  and `reactions` tables (RLS) and `my_community_permissions()`.
- **Tests:**
  - `apps/mobile/src/features/feed/feed.test.tsx` (23)
  - `tests/services/feed.test.ts` (5, real Supabase)
  - main post flows in `tests/services/content.test.ts`

## What the user can do

| Action | Shown when (display only) | Authorized by (database) |
|---|---|---|
| Read the feed | Always | `posts.view` (RLS on `posts`) |
| Write a post ("New post", or "Write the first post" on an empty feed) | `posts.create` | RLS insert policy: `posts.create` in that community. The author is set from the session by the database. |
| Edit own post | Own, published post, `posts.edit_own` | RLS + write trigger: author, `posts.edit_own`, published only; moderators can never change text |
| Delete own post (asks first; soft delete) | Own post, `posts.delete_own` | Author with `posts.delete_own`, or `posts.moderate` |
| Like / unlike | Published posts | `reactions` RLS: a member who can see the post; one reaction per user |
| "Hidden" view | Everyone | RLS returns hidden posts only to moderators and to their own author |
| "Deleted" view | `posts.moderate` | RLS returns deleted posts only to moderators and to their own author |

**Nothing the app decides is trusted.** The community id comes from
`useCommunity()`, the user's own memberships checked with the server. The
author is never sent (`posts.insert` sends `community_id` and `body` only). The
edit and delete buttons depend on `author_user_id` and
`my_community_permissions()`, but only to show or hide them: a refused action
(for example, a post hidden by a moderator while being edited, or a permission
removed meanwhile) shows "You can't edit this post." or the server's message,
and nothing changes. Rows of another community are dropped and logged, as on
the home screen.

## Post card

| Element | Source | Notes |
|---|---|---|
| Author | `author_display_name` | "Deleted User" when the author's account was deleted (`author_user_id` NULL); "Member" when they have no display name |
| Time, "Edited" | `created_at`, `edited_at` | |
| Body | `body` | Full text in the feed; 3 lines on the home |
| Reactions | `reaction_count`, `my_reaction_type` | Like toggle; counts update after the server confirms |
| Comments | `comment_count` | Count only (comments come in a later stage) |
| Moderation state | `status`, `moderation_reason` | "Hidden by a moderator: {reason}" or "Deleted". The server sends these rows, and the reason, only to moderators and the author. |

## Pagination and refresh

- Keyset pagination through the backend cursor (`services.posts.list`, pages of
  20). The feed is never loaded whole. The next page is requested when the list
  reaches its end (`onEndReached`), or with the "Load more posts" button, which
  is the accessible path. Duplicates are ignored. "You're all caught up." marks
  the end.
- Pull to refresh reloads the first page. The feed also refreshes when the user
  comes back from writing or editing a post, so it always shows the server's
  version.

## States

| State | Behaviour |
|---|---|
| Loading | "Loading posts…" |
| Empty | "No posts yet", with "Write the first post" if allowed; "No hidden posts" / "No deleted posts" in those views |
| Error (first page) | "Posts could not be loaded", with "Try again" |
| Error (next page or refresh) | The posts stay; the error and "Try again" appear at the end of the list |
| Action error (like, delete) | Shown on the post's card |

## Known limitations

- Comments, all reaction types and moderation (hide or restore) were added in
  RN-08: see [`comments-and-reactions.md`](comments-and-reactions.md). Author
  avatars (the feed function returns `author_avatar_url` only) and images in
  posts are not built yet.
- No real-time updates: pull to refresh.

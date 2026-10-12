# Comments, Reactions and Moderation (RN-08)

The interaction layer on posts in the mobile app: comment threads with
replies, reactions of every supported type, and moderation for those allowed.
It is built on the existing Stage 5 backend; no migration was needed.

- **Screens and components:** `apps/mobile/src/features/comments/`
  - `PostDetailScreen`
  - `CommentThread`, with comment items and nested replies
  - `CommentComposer`
  - `ThreadContext`
  - `useComments`
- **Reactions:** `apps/mobile/src/features/reactions/`
  - `reactions.ts`: types and arithmetic
  - `useReaction`: the controller
  - `ReactionBar`
- **Moderation controls:** `apps/mobile/src/features/feed/components/ModerationControls.tsx`
- **Service change:** `services/posts/index.ts`, where `react()` tolerates a concurrent duplicate
- **Tests:**
  - `apps/mobile/src/features/comments/interactions.test.tsx` (24)
  - `tests/services/interactions.test.ts` (9, real Supabase)
  - RN-07 feed tests updated for the reaction bar

## Comments

| Feature | How |
|---|---|
| List | "N comments" on a post opens it. Top-level comments come oldest first, 20 per page, via `list_post_comments()` keyset cursor, then "Load more comments". |
| Replies | "View N replies" loads that comment's replies (same paging) as an indented thread. Replies nest up to depth 9 (database CHECK); deeper replies are not offered. |
| Create / reply | A composer under the post, or "Reply" on a comment. Not optimistic: the comment appears once the server has accepted it. The post's comment count updates. |
| Edit own | Inline editor on your own published comment (`comments.edit_own`). The database allows authors only; moderators can never change text. |
| Delete own | Asks first; soft delete. With replies, a "Comment deleted" placeholder keeps them reachable; otherwise the comment disappears. |
| What you see | Published comments of visible posts. Hidden and deleted comments only if you are a moderator (`comments.moderate`) or their author (RLS: `can_view_comment_row`). |

The database enforces every rule, and the app shows the refusal:
- **New comments** need a published, visible post and `comments.create`.
- **A reply** must be to a published comment on the same post. Otherwise: "Parent comment not found on this post", which does not reveal whether the parent exists.
- **Edits** apply only to your own published comments.

## Reactions

- **Types:** Like, Love, Celebrate, Support, Laugh, Sad (`reactions.reaction_type`
  CHECK). Tap "React" to like, or remove your reaction. "Choose a reaction"
  opens all six. Counts are shown per type, from `get_reaction_summary()`: one
  call per page of posts or comments, never one per item. If that call fails,
  the total is shown instead.
- **One reaction per user and post/comment** (unique indexes). Choosing
  another type changes it, and the counts move with it.
- **Optimistic, because it is safe:** a reaction is reversible and low-risk, so
  it shows at once. `useReaction` keeps **one request at a time per target**:
  taps during a request only record the latest choice, which is sent when the
  request returns. Like → unlike → like in quick succession therefore sends a
  single reaction, and requests never overlap. The test holds every request and
  checks this.
- **Rejected:** the display reverts to the last confirmed state and the error
  is shown on the item. If the **server** refused (e.g. the content was hidden
  meanwhile), the affected data is refreshed. After a network failure nothing
  changed on the server, so nothing is refreshed.
- **Server side (duplicate safety):** `posts.react()` reads the existing
  reaction, then inserts. Two simultaneous requests from the same user could
  both insert, and the second used to fail with `23505`. It now becomes a type
  change. `tests/services/interactions.test.ts` sends six concurrent reactions:
  all succeed, and exactly one reaction is stored. This test fails without the
  change.

## Moderation

| Action | Shown when (display only) | Authorized by |
|---|---|---|
| Hide post (optional reason, shown to the author) / restore | `posts.moderate` | posts write trigger + RLS (`posts.moderate`) |
| Hide comment / restore | `comments.moderate` | comments write trigger + RLS (`comments.moderate`) |

Members see no moderation controls at all. Moderation is not optimistic: the
item changes once the server confirms. A hidden post leaves the "Posts" view
and appears under "Hidden" with its reason. A moderator's powers stop at their
community: hiding another community's post is `NOT_FOUND`.

## What is not optimistic, and why

Comment creation, edits, deletes and moderation wait for the server. They
change what other people see, can be refused for many reasons (permissions,
the post hidden meanwhile, a parent removed), and a wrong optimistic state
would be misleading. Double submits are prevented by a ref-guarded composer and
disabled buttons while a request runs.

## Cross-community protection

- A post is opened from the current community's feed and **re-read from the
  server** (`posts.get`). If it is no longer visible (hidden, deleted) or not in
  the current community, the screen says "This post is not available" instead
  of showing the feed's stale copy.
- Comment lists are requested by post id; rows of another post or level are
  dropped. Reaction summaries are requested only for ids on screen.
- Switching community remounts the community stack, so no post or thread of the
  previous community stays open.
- The server rules are tested with real Supabase: a member of another community
  cannot list, comment, react or moderate, and their reaction summary for those
  ids is empty.

## Known limitations

- Only a placeholder (no reason) is shown for hidden comments; the comment
  list function does not return the moderation reason.
- When a parent comment is deleted, other members can no longer open its
  replies (the parent is not returned to them). The author and moderators still
  can.
- No real-time updates, mentions, attachments, or reaction lists ("who
  reacted").

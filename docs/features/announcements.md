# Announcements (Stage 6)

Official community communications from authorized community leaders. They are
separate from posts: no comments or reactions, a managed lifecycle, priority and
expiry. Every rule here is enforced in Postgres.

- **Migration:** `supabase/migrations/20261011001200_announcements.sql`
- **Tests:**
  - `supabase/tests/database/013_announcements.test.sql` (pgTAP, 52)
  - `tests/integration/announcements.test.mjs` (end to end through the Data API)

## Table: `announcements`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `community_id` | NOT NULL, FK → communities (**RESTRICT**), immutable |
| `author_user_id` | Defaults to the validated session user and is not client-writable. FK → profiles **ON DELETE SET NULL**: official communications outlive the author's account, so this column is nullable. |
| `title` | 1–200 chars |
| `body` | 1–20 000 chars |
| `priority` | `normal` (default) \| `important` |
| `status` | `draft` (default) \| `published` \| `archived` \| `deleted` |
| `published_at` | **Server-stamped** on every (re)publication; not client-writable |
| `expires_at` | Optional. Must be later than `published_at`, and in the future when publishing. |
| `archived_at` | Server-stamped on archive; cleared on republish |
| `edited_at` | Server-stamped when a *published* announcement's content changes |
| `updated_by_user_id` | Server-stamped: the last client user who changed it |
| `created_at`, `updated_at` | |

**Constraints:**

- published and archived announcements must have `published_at`;
- `expires_at > published_at`;
- the allowed values for `priority` and `status`.

**Indexes:**

| Index | Columns | Serves |
|---|---|---|
| `announcements_community_status_published_idx` | `(community_id, status, published_at desc, id desc)` | community, status and publication-date queries |
| `announcements_community_expiry_idx` | `(community_id, expires_at) WHERE status = 'published'` | expiry |
| `announcements_author_idx` | `author_user_id` | author lookups |

## Permissions

| Permission | Grants |
|---|---|
| `announcements.view` | Read published (including expired) and archived announcements |
| `announcements.create` | Create announcements, and manage **your own**: edit, publish, archive, republish, delete |
| `announcements.manage` | Manage **any** announcement in the community, and see drafts and deleted announcements |

With the default roles, Owners and Admins have all three, while Moderators and
Members have `announcements.view` only. Communities can create a custom role
holding `announcements.create` without `manage`, for an author who manages only
their own announcements. Nothing checks a role name.

## Lifecycle

```
            publish                archive
  draft ───────────────► published ───────► archived
                             ▲                  │
                             └──── republish ───┘
  draft | published | archived ──► deleted   (terminal, soft)
```

| Action | Call | Rules |
|---|---|---|
| Save draft | `insert({ community_id, title, body, priority?, expires_at? })` | `announcements.create` |
| Create and publish at once | `insert({ ..., status: 'published' })` | Stamps `published_at` |
| Publish | `update({ status: 'published' })` | from `draft` or `archived`; stamps `published_at = now()`; `expires_at` must be null or in the future |
| Edit | `update({ title, body, priority, expires_at })` | only while `draft` or `published`; edits to a published announcement stamp `edited_at` |
| Archive | `update({ status: 'archived' })` | from `published`; stamps `archived_at` |
| Delete | `update({ status: 'deleted' })` | from any non-deleted status; terminal |
| Hard delete | not possible | No client DELETE privilege |

- Any other transition is rejected with `22023`.
- Changing a deleted announcement is rejected with `42501`.
- `community_id`, `author_user_id`, `created_at` and `published_at` can never be
  set by clients.

## Expiration

Expiry is **time-based**, so no background job is needed. A published
announcement whose `expires_at` has passed:

- stays `status = 'published'`;
- is **not** returned by `list_current_announcements`;
- **is** returned by `list_announcement_history` with `is_expired = true`, and
  can still be read by id.

To end an announcement early, either archive it or set `expires_at` to a time
between `published_at` and now. Republishing an expired announcement requires
clearing `expires_at` or moving it into the future.

## Visibility (RLS)

| Status | Visible to |
|---|---|
| `published` (current or expired), `archived` | `announcements.view` or `announcements.manage` in that community |
| `draft`, `deleted` | `announcements.manage`, or the **author** while they hold `announcements.create` |

- All checks go through `has_community_permission()`, which requires an active
  membership in an active community, a live session and an active account.
  Pending or suspended members and other communities see nothing.
- Authors can see their own deleted announcements. Postgres requires the row an
  UPDATE produces to stay visible to the user making it, so this is also what
  makes soft-delete work.

**Write policies:**

| Operation | Allowed when |
|---|---|
| INSERT | `author_user_id` is the session user, `status` is draft or published, and the user has `announcements.create` in `community_id` |
| UPDATE | `private.can_manage_announcement_row()`: `announcements.manage`, or you are the author and hold `announcements.create` |

The trigger `private.enforce_announcement_write()` then enforces the lifecycle
rules above.

**Cross-community access is impossible:**

| Attempt | Result |
|---|---|
| Insert with another community's `community_id` | `42501` |
| Change `community_id` | `42501` (not writable, and immutable) |
| Read by id, filter by community id, or pass another community's id to the list functions | `[]` |
| Owner of B updates an announcement in A | 0 rows |

## Read API

```ts
// Current: published and not expired. Important first, then newest.
const page1 = await supabase.rpc('list_current_announcements', { p_community_id, p_limit: 20 });
const last = page1.data.at(-1);
const page2 = await supabase.rpc('list_current_announcements', {
  p_community_id, p_limit: 20,
  p_cursor_priority: last.priority, p_cursor_published_at: last.published_at, p_cursor_id: last.id,
});

// History: published (including expired) and archived, newest first.
// Managers may pass p_statuses: ['draft'] or ['deleted'].
const history = await supabase.rpc('list_announcement_history', { p_community_id, p_limit: 20 });
// next page: p_cursor_sort_at: last.sort_at, p_cursor_id: last.id

// By id
await supabase.from('announcements').select('*').eq('id', announcementId).single();
```

- Both list functions are `SECURITY INVOKER` and use keyset pagination: default
  page size 20, maximum 50.
- A partial cursor is rejected with `22023`.

## Management and moderation

- **Managers** (`announcements.manage`) can edit, archive, republish or delete
  any announcement, and review drafts and deleted announcements through the
  history function.
- **Accountability:** `updated_by_user_id` and `edited_at` record who last
  changed an announcement and whether published content was edited. A full
  history of the text is not kept; the audit log (Stage 11) records creation,
  publication and deletion with the actor.
- Deleted announcements are kept (soft delete) as a record.

## Hooks for later stages

No notifications are sent in this stage. A future notification stage can trigger
on `status` becoming `published`, and use `priority = 'important'` to decide
urgency. Those columns already exist.

## Known limitations

- No scheduled publishing (a future `published_at` is not supported).
- No per-announcement audience. Every member with `announcements.view` sees
  every published announcement.
- No read receipts.
- The history list orders by `coalesce(published_at, created_at)`, which the
  index does not fully cover. That is fine at community scale; revisit if
  histories grow very large.

## Mobile app

The member and management screens are described in
[`announcements-app.md`](announcements-app.md) (RN-09).

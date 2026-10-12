# Notifications (Stage 9)

In-app notifications, plus the reusable server-side notification service that
other modules use. Push, email and SMS are **not** implemented. The design leaves
room for them without changing the `notifications` table.

- **Migration:** `supabase/migrations/20261011001500_notifications.sql`
- **Tests:**
  - `supabase/tests/database/016_notifications.test.sql` (pgTAP, 59)
  - `tests/integration/notifications.test.mjs` (end to end through the Data API)

## Tables

### `notifications`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `user_id` | NOT NULL. The recipient (owner). FK → profiles **CASCADE**: account deletion removes the user's notifications. |
| `community_id` | Optional. FK → communities **CASCADE**: notifications are derived data. |
| `type` | FK → `notification_types.key` |
| `title` | 1–200 chars |
| `body` | ≤ 1 000 chars, usually a short excerpt |
| `data` | JSON object, ≤ 8 KiB. Deep-link ids (e.g. `announcement_id`, `event_id`), not copies of protected content. |
| `dedupe_key` | Unique per user. The same source event never notifies a user twice. |
| `read_at` | NULL = unread. Set to server time; cannot be back-dated. |
| `archived_at` | NULL = in the inbox |
| `created_at` | |

**Indexes:**

| Index | Columns |
|---|---|
| `notifications_user_created_idx` | `(user_id, created_at desc, id desc)` |
| `notifications_user_unread_idx` | `(user_id, read_at) WHERE archived_at IS NULL` |
| `notifications_community_created_idx` | `(community_id, created_at desc)` (partial) |
| `notifications_user_dedupe_key` | unique `(user_id, dedupe_key)` |

### `notification_types` (catalog)

| Column | Meaning |
|---|---|
| `key` | The type name |
| `description` | What it means |
| `requires_membership` | Community-scoped notifications of this type are created for, and readable by, **active members only** |
| `default_priority` | `low` \| `normal` \| `high` \| `critical`, for future channel routing |

Adding a type means inserting a row in a migration, together with the code that
produces it.

## Notification types

Only types that are actually produced exist.

| Type | Produced when | Recipients | Requires membership | Priority |
|---|---|---|:-:|---|
| `announcement` | An announcement is published (or republished) | Active members with `announcements.view`, except the author | ✓ | normal |
| `alert` | An alert is published or withdrawn (from the Stage 7 `alert_events` outbox) | Active members with `alerts.view`, except the actor | ✓ | high |
| `event_created` | An event is published | Active members with `events.view`, except the creator | ✓ | low |
| `event_updated` | A published event's time or place changes; also when *you* are promoted from the waitlist (`data.reason`) | Members who RSVP'd going, maybe or waitlisted / the promoted member | ✓ | normal |
| `event_cancelled` | A published event is cancelled | Members who RSVP'd going, maybe or waitlisted | ✓ | high |
| `comment` | A comment on your post, or a reply to your comment | The post author / the parent comment's author (never the commenter) | ✓ | normal |
| `membership` | Your membership becomes active (approved or reinstated), suspended, or rejected | The member | ✗ | normal |
| `system` | Platform or account messages from backend code | Any user | ✗ | normal |

**Planned, added with their producers:**

| Type | Waiting on |
|---|---|
| `community_invitation` | Person-targeted invitations. Stage 4 invitations (Pre-Stage 12) are shareable links with no recipient account, so there is nobody to notify; joining through one produces the normal `membership` notification. |
| `event_reminder` | A scheduler |
| `reaction` | A product decision about whether reactions should notify at all |

## Notification lifecycle

```
created (unread) ──mark read──► read ──mark unread──► unread
      │                          │
      └──────archive─────────────┴──► archived (hidden from the inbox; still listable)
any ──delete──► gone (the owner may delete their own notifications)
```

| Operation | Call |
|---|---|
| List (newest first, keyset cursor, ≤ 100 per page) | `rpc('list_my_notifications', { p_limit, p_cursor_created_at, p_cursor_id, p_unread_only, p_community_id, p_include_archived })` |
| Unread count (optionally for one community) | `rpc('unread_notification_count', { p_community_id })` |
| Mark read / unread | `rpc('mark_notification_read' / 'mark_notification_unread', { p_notification_id })`, returns whether anything changed |
| Mark all read (optionally per community) | `rpc('mark_all_notifications_read', { p_community_id })`, returns the number changed |
| Archive | `rpc('archive_notification', { p_notification_id })`, which also marks it read |
| Delete | `from('notifications').delete().eq('id', id)` |

All of these are `SECURITY INVOKER`, so RLS applies to every row. Notification
content (`user_id`, `type`, `title`, `body`, `data`, `community_id`) is
**immutable**, even for its owner. Only `read_at` and `archived_at` change, and
the server stamps them with its own clock.

## Notification service

Other modules never insert into `notifications` directly. They call the
service:

```sql
-- createNotification({ userId, communityId, type, title, body, data, dedupeKey })
select private.create_notification(user_id, community_id, 'comment', 'New comment on your post',
                                   excerpt, jsonb_build_object('post_id', ...), 'comment:<id>:post_author');

-- Fan-out to every active member holding a permission, except the actor
select private.notify_community(community_id, 'announcements.view', 'announcement',
                                title, excerpt, data, 'announcement:<id>:<published_at>', actor_id);
```

| Function | Callable by | Purpose |
|---|---|---|
| `private.create_notification(...)` | other SECURITY DEFINER functions and triggers only | Create one notification. Validates the type; for membership-requiring types, the recipient must be an **active member** of `community_id`. Deduplicates. |
| `private.notify_community(...)` | the same | Set-based fan-out to active members (active account) holding a permission key |
| `public.create_notification(...)` | the **service role only** | Entry point for backend code (Edge Functions, workers) holding the service-role key |
| `private.community_members_with_permission(...)` | internal only | Resolves recipients. It can compute permissions for any user, so it is never exposed. |

**Producers** are AFTER triggers in the same transaction as the source change,
so a notification exists if and only if the change committed:

| Trigger | Fires on |
|---|---|
| `announcements_notify` | announcement publication |
| `alert_events_notify` | Stage 7 alert outbox |
| `events_notify` | event publication, change or cancellation |
| `event_rsvps_notify_promotion` | waitlist promotion |
| `comments_notify` | new comments |
| `memberships_notify` | membership status changes |

The actor is never notified about their own action. Server-side actions are
attributed to no one.

## Authorization and RLS

| Operation | Rule |
|---|---|
| SELECT, UPDATE, DELETE | `private.can_read_notification()`: the row belongs to the caller (live session, active account), **and**, for a community-scoped notification of a membership-requiring type, the caller can still view that community (`community.view`) |
| UPDATE | Only `read_at` and `archived_at` are grantable; a trigger makes everything else immutable |
| INSERT | Not granted to any client role. Ever. |

**Guarantees, all tested at both the database and the API level:**

- A user cannot read, modify, archive or delete another user's notifications.
  This applies even to a community Owner.
- **No client can create notifications.** That covers direct inserts, the public
  RPC, the internal service and the fan-out function, for every client role.
- Even trusted server code cannot create a community notification for a
  non-member.
- **No cross-tenant leakage:**
  - recipients are resolved per community and per permission key;
  - a notification about community A can never be created for a non-member of A;
  - once a user is suspended from, leaves or is removed from a community, its
    content notifications become unreadable and stop counting as unread;
  - they stay unreadable through deep-link ids too, and the `membership` notice
    about their own status remains visible.
- The update and delete policies mirror the read policy as defence in depth.
  Since only the owner can see a notification, the read policy is the effective
  barrier.

## Future channels (push, email, SMS)

The `notifications` row is the **in-app record and the single source of truth**.
Channels are added **beside** it, never inside it:

```
source change ──trigger──► notifications row (in-app)
                               │
                               └──► notification_deliveries (one row per channel per notification)
                                         ▲            │
                         channel router ─┘            └──► push (FCM/APNs) / email / SMS providers
                 (type priority + user preferences)
```

Planned tables (not created yet):

| Table | Purpose |
|---|---|
| `notification_preferences (user_id, type, channel, enabled, quiet_hours)` | Per-user opt-in and opt-out |
| `push_devices (user_id, platform, token, last_seen_at)` | Expo or FCM/APNs tokens, written by the mobile app for its own user |
| `notification_deliveries (notification_id, channel, status, attempts, last_error, sent_at)` | Per-channel delivery state, for retries and receipts |

**Routing:**

- A worker using the service role picks up new notifications. Use
  `FOR UPDATE SKIP LOCKED`, or a delivery queue fed by a trigger.
- It chooses channels from `notification_types.default_priority`, the user's
  preferences and, for alerts, `data.severity`. Emergency alerts bypass quiet
  hours, following the policy in `alerts.md`.
- It writes delivery rows and calls the providers.

The Stage 7 `alert_events` outbox already feeds both in-app notifications
(through `alert_events_notify`) and, later, the external channels.

Nothing in this design requires changing the `notifications` table:
- channel state lives in `notification_deliveries`;
- preferences live in their own table;
- payloads come from `title`, `body` and `data`.

## Known limitations

- **Fan-out is synchronous,** inside the publishing transaction. That is fine
  at community scale; very large communities should move fan-out to an
  asynchronous worker using the same service.
- **No retention policy.** Old read or archived notifications are kept
  indefinitely.
- **No digests or batching.** For example, ten comments produce ten
  notifications.
- **Realtime is not enabled** for the notifications table yet. Clients poll the
  unread count.

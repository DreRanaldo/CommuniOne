# Notification Center in the Mobile App (RN-12)

The in-app notification center: the user's own notifications, unread state,
marking read, and opening the item a notification is about. The backend is
Stage 9 (see [`notifications.md`](notifications.md)). **No migration was
needed.** Push notifications are a later stage.

- **Screens:** `apps/mobile/src/features/notifications/screens/`
  - `NotificationsScreen`: All / Unread tabs, "Mark all read", pages of 20
  - `NotificationDetailScreen`: one notification in full, read / unread toggle, open its item
- **Rules and hooks:** `apps/mobile/src/features/notifications/`
  - `notificationRules.ts`: what a notification leads to (`notificationTarget`), icons and labels
  - `useOpenNotification.ts`: mark read, switch community (server-checked), navigate
  - `useNotificationList.ts`: keyset pages, refresh, local read state
  - `NotificationItem.tsx`: one row
- **Document destination:** `apps/mobile/src/features/documents/DocumentDetailScreen.tsx`
  (minimal: name, type, size, date and "Open document" through a 60-second signed link;
  the document library is a later stage)
- **Entry point:** the bell in the feed header, with an unread badge (99+ above 99)
- **Service:** `notifications.get(id)` (new; owner only through RLS)
- **Tests:**
  - `apps/mobile/src/features/notifications/notifications.test.tsx` (24)
  - `notificationRules.test.ts` (13)
  - `tests/services/notifications-ui.test.ts` (4, real Supabase)

## Routes and deep links

| Route | Where | Deep link |
|---|---|---|
| `Notifications` | root stack (over the tabs) | `communione://notifications` |
| `NotificationDetail` | root stack | `communione://notifications/<notificationId>` |
| `DocumentDetail` | community stack | – |

## Where a notification leads

| Type | Data key | Destination |
|---|---|---|
| `comment` | `post_id` | Home → `PostDetail` |
| `announcement` | `announcement_id` | Communities → `AnnouncementDetail` |
| `alert` | `alert_id` | Alerts → `AlertDetail` |
| `event_created` / `event_updated` / `event_cancelled` | `event_id` | Communities → `EventDetail` |
| `membership` (status `active` only) | `community_id` | Communities → `CommunityHome` |
| others (e.g. `system`) | first of `post_id`, `announcement_id`, `alert_id`, `event_id`, `document_id`, `community_id` | as above; `document_id` → `DocumentDetail` |

A notification with nothing to open (e.g. a welcome message) opens its detail
screen instead.

## Security: notification data is not trusted

The notification only says *where to look*. It never grants access:

1. **Only the owner's notifications exist for the app.** `list`, `get`,
   `unreadCount` and the mark functions go through RLS
   (`private.can_read_notification`): the owner, and for community content
   types (`requires_membership`) only while still an active member. A link to
   someone else's notification shows "This notification is not available".
2. **Ids must be well formed.** Only UUIDs are accepted from `data`; anything
   else leads nowhere. The type decides which key is read (a `comment` never
   opens an `alert_id`).
3. **The community is re-checked on the server.** If the item is in another
   community, the app calls `select()`, which re-reads the user's memberships
   from the server; if the user is no longer an active member nothing opens and
   the app says "You can't open this any more…".
4. **Each destination re-reads its item** through RLS and refuses an item from
   a different community than the current one (a forged `community_id` does not
   help). Hidden posts, managers-only documents and removed items show
   "not available".
5. **Notification content is immutable** (database trigger): the app can only
   change `read_at` / `archived_at` through the RPCs.

Navigation uses `popTo('App', …)`: React Navigation 7's `navigate` would stack
a second copy of the tabs on top of the center.

## Unread count

- The bell loads `unread_notification_count()` with the feed and on refresh;
  the center reloads it after every change and when it regains focus.
- There is no realtime subscription yet: a new notification shows on the next
  refresh (pull to refresh, focus or reopening the center).

## Known limitations

- No push notifications (later stage).
- No producer writes `document_id` yet; the document route is ready for it.
- No archive or delete in the UI (the service supports both).
- Cold-start deep links to a notification open it on its own (no tabs below);
  opening its item then shows the tabs.

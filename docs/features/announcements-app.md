# Announcements in the Mobile App (RN-09)

Official community announcements: reading them as a member, and writing and
managing them with the announcement permissions. The backend is Stage 6 (see
[`announcements.md`](announcements.md)); no migration was needed.

- **Screens:** `apps/mobile/src/features/announcements/`
  - `AnnouncementsScreen`: Current, Past and Drafts
  - `AnnouncementDetailScreen`
  - `AnnouncementEditorScreen`
- **Components and rules:**
  - `AnnouncementItem`: also used on the community home
  - `announcementRules.ts`: labels, controls, expiry date, error messages
  - `useAnnouncementList.ts`
- **Tests:**
  - `apps/mobile/src/features/announcements/announcements.test.tsx` (17)
  - `announcementRules.test.ts` (5)
  - `tests/services/announcements-ui.test.ts` (7, real Supabase)

## Member experience

| View | Source | Contents |
|---|---|---|
| **Current** | `list_current_announcements()` | Published and not expired; **important first**, then newest |
| **Past** | `list_announcement_history()` | Published ones, including expired ones (marked **Expired**), and archived ones (marked **Archived**) |
| **Detail** | `announcements.get` (RLS) | Priority, title, dates, full text |

The hierarchy is the same in the list and the detail:
1. **Priority:** a megaphone with "Announcement" or "IMPORTANT ANNOUNCEMENT",
   and a stronger accent colour for important ones.
2. **Title:** heading or title style.
3. **Dates:** "Published 12 Oct 2026 · Edited · Expires 20 Oct 2026" (or
   "Expired …", "Archived …").
4. **Body.**

Announcements deliberately look different from posts. They have no author
avatar, reactions or comments; they carry an accent strip and the
"Announcement" label. They are official communications, not conversation.

## Authorized experience

| Control | Shown when (display only) | Authorized by the database |
|---|---|---|
| "New" button, "Drafts" view | `announcements.create` or `announcements.manage` | Insert RLS; drafts are visible to managers (all) and authors (their own) |
| Edit | Draft or published, and you may manage it | RLS `can_manage_announcement_row`; trigger: only draft or published can be edited; published edits are stamped `edited_at` |
| Publish (asks first: "All members will be notified") | Draft | Trigger transition; `published_at` stamped by the server; expiry must be in the future |
| Archive (asks first) | Published | Trigger transition; `archived_at` stamped |
| Publish again | Archived | Trigger transition |
| Delete (asks first; cannot be undone) | Any except deleted | Soft delete; terminal |

**"May manage it"** means `announcements.manage` for any announcement, or
`announcements.create` for **your own**. Members see none of these controls.

Nothing is optimistic. Each action waits for the server and shows its result:
"Published. Members have been notified." or "Archived."; a delete returns to
the list. The editor sends only the community (the current one), title, body,
priority and expiry. The author and all dates are set by the database.

**Server refusals in plain words** (`announcementError`):

| Refusal | Message |
|---|---|
| Expiry passed when publishing | "The expiry date has passed. Choose a later date or remove it, then publish." |
| Invalid transition (changed elsewhere) | "This announcement has changed meanwhile…" |
| Permission removed meanwhile | "You don't have permission to change this announcement." |
| Announcement gone | "This announcement is no longer available." |

After a refusal the announcement is re-read; the message stays on screen.

**Expiry in the editor:** an optional date, `YYYY-MM-DD`, meaning the end of
that day on the device. It is checked before sending (format, real date, in the
future), and the database checks it again when publishing.

## Community isolation

- Lists are requested for the current community only. Rows of another
  community are dropped.
- The detail and the editor refuse an announcement that is not in the current
  community.
- Switching community remounts the community stack.
- The community home's announcements section opens the same detail screen, and
  "See all" opens the list.

## Known limitations

- No rich text, attachments or images in announcements; no scheduled publication.
- The expiry is a date, not a time of day; the end of that day uses the device's time zone.
- Read receipts and acknowledgements are not supported by the backend.

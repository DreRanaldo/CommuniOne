# Community Settings (RN-15)

Settings for the current community: every member chooses which notifications
it sends them and can leave it. Members allowed to manage the community also
edit its profile.

- **Migration 29:** `supabase/migrations/20261011002900_community_notification_settings.sql`
- **Service:**
  - `communities.notificationSettings(id)` and `communities.setNotificationSettings(id, patch)` are new.
  - Existing: `communities.update`, `uploadImage`, `removeImage`, `memberships.leave`.
- **App:** `apps/mobile/src/features/settings/screens/`
  - `CommunitySettingsScreen`: from the hub's ⚙ button
  - `EditCommunityScreen`: from "Manage community" (hub card or settings)
- **Tests:**
  - `supabase/tests/database/030_community_settings.test.sql` (pgTAP, 38)
  - `tests/services/community-settings.test.ts` (5, real Supabase)
  - `apps/mobile/src/features/settings/settings.test.tsx` (16)

## Member settings

### Notification preferences (per community)

| Setting | Notifications it controls | Default |
|---|---|---|
| Announcements | `announcement` | on |
| New events | `event_created` | on |
| Replies to you | `comment` | on |
| Info and warning alerts | `alert` with severity info / warning | on |

**Always delivered, whatever the settings:**
- urgent and emergency alerts;
- changes to or cancellations of events you replied to, and waitlist promotions (`event_updated`, `event_cancelled`);
- membership and system notifications.

**Enforced in the database:**
- `private.create_notification()` and `private.notify_community()` skip recipients who turned that kind off for that community. Every producer goes through one of these two functions.
- Settings are per community: muting announcements in one community does not affect another.
- Clients read only their own row (RLS) and have no direct writes.
  - `set_community_notification_settings()` writes them; a NULL argument leaves that value unchanged.
  - `my_community_notification_settings()` reads them; with no row stored, it returns the defaults.
  - Both require an active membership (`community.view`) in that community.
- In the app, switches update at once and revert if the server refuses.

### Leaving

- "Leave {community}" asks for confirmation, then calls `memberships.leave`.
- The app returns to the hub and re-reads the memberships, so it moves on to
  another community or to "Your communities".
- **The last member able to manage roles cannot leave** (database rule since
  Stage 1, `private.is_sole_role_manager`). The app explains: "You're the only
  one who can manage roles…, give another member the Owner role first."
- **No ownership-transfer workflow** was built: the backend has none. Since
  RN-16 an Owner can give another member the Owner role in Admin tools →
  Members, then leave.

### Community-specific preferences

The notification settings above are the per-community preferences the backend
supports. There are no other per-community member preferences yet.

## Community management (`community.update`)

| Who | Edit profile, logo, cover | Manage roles | Leave |
|---|---|---|---|
| Owner | ✓ | ✓ | only if someone else can manage roles |
| Admin | ✓ | – | ✓ |
| Moderator, Member | – | – | ✓ |

- **Editable:** name (≤ 120 characters), description (≤ 2000), type, and time zone.
  - The time zone is checked by the app and by the database trigger. The app offers "Use this device's time zone".
- **Images:** logo and cover go in the public `community-media` bucket, as in RN-05. Uploads, replacements and removals apply at once.
- **Never editable:** the address (slug) and the status. There is no column
  grant for them, so the database refuses (`42501`), even for Owners.
- **Visibility:** "Manage community" appears only with `community.update`. The
  edit screen checks the permission too, and the database refuses everyone else:
  - members and moderators get `FORBIDDEN`;
  - outsiders get `NOT_FOUND` (they cannot even see the community).

## Known limitations

- No push notifications yet (in-app only). The same preferences will apply to push when it is added.
- No per-type muting beyond the four groups, and no "mute for a while".
- Role management is in the admin tools (RN-16, [`mobile-admin.md`](mobile-admin.md)); there is no ownership-transfer workflow.

# Community Home (RN-06)

The landing page of the current community in the mobile app: who the
community is, what needs attention now, and the way into everything else.

- **Screen:** `apps/mobile/src/features/communities/screens/CommunityHomeScreen.tsx`
- **Data:** `apps/mobile/src/features/home/useCommunityHome.ts`
- **Components:** `apps/mobile/src/features/home/components/`
  - `CommunityHeader`, `EventCard`, `PostCard`; alerts use `AlertCard` from
    `features/alerts` (RN-10) and announcements `AnnouncementItem` (RN-09)
  - `HomeSection`, a generic section handling items, empty and error states
  - `QuickActions`
  - `SectionHeader` (shared, in `src/components/`)
- **Backend:** no new migration. It uses the existing list functions.
- **Tests:**
  - `apps/mobile/src/features/home/home.test.tsx` (16)
  - `tests/services/community-home.test.ts` (4, real Supabase)

## Layout and priority

| # | Section | Source | Order / limit |
|---|---|---|---|
| – | Community header: cover, logo, name, type, your role, description | `my_communities()` (current community) + `communities.get` | |
| 1 | **Alerts** | `alerts.listActive` | Emergencies first (severity rank), then newest; up to 5 |
| 2 | **Announcements** | `announcements.listCurrent` | Important first, then newest; up to 3 |
| 3 | **Upcoming events** | `events.listUpcoming` | Soonest first, in the event's time zone; up to 3 |
| 4 | **Recent activity** | `posts.list` | Newest 3 posts |
| – | **Explore**: Feed, Announcements, Alerts, Events, Documents, Members | | |

- The page is a summary, not a feed: each section shows a few items and a
  "See all" link to its section.
- Alerts show their severity with an icon and label, not colour alone. An
  active emergency is a solid emergency-coloured block announced to screen
  readers; tapping an alert opens its detail (RN-10, see [`alerts-app.md`](alerts-app.md)).
- Important announcements are highlighted.
- A post by a deleted account shows "Deleted User".

## Community context

- The community comes from `useCommunity()` (`CurrentCommunityProvider`), never
  from a route parameter. The hub stack is remounted when the community changes,
  so nothing from the previous community stays on screen.
- Every request carries that community's id, and the database decides what the
  user may see. The list functions check `*.view` permissions inside the
  function and return **nothing** for a non-member or a pending, suspended or
  archived membership. `communities.get` returns `NOT_FOUND`.
- As a second line of defence, the app drops any row whose `community_id` is not
  the current community, and logs `home.foreign_items_dropped` (counts only).
- Because a lost membership looks like empty lists, a refresh first re-checks
  the memberships (`CurrentCommunityProvider.refresh()`). If access is gone, the
  provider leaves the community with "You no longer have access to …". A
  `NOT_FOUND` from `communities.get` triggers the same check.

## States

| State | Behaviour |
|---|---|
| Loading | "Loading {community}…" on first load |
| Empty | All four sections empty: "It's quiet in {community}", with shortcuts kept. A single empty section shows one line ("No upcoming events."). |
| Partial error | A failing section shows a safe message and "Try again"; the other sections stay |
| Error | Nothing could be loaded: "{community} could not be loaded", with "Try again" |
| Offline (first load) | "You're offline. Check your connection and try again.", with "Try again" |
| Offline (refresh) | The last content stays, with the banner "You're offline. Showing what was loaded at 14:05", and "Try again" |
| Refresh | Pull to refresh. Also on returning to the home from another screen (content stays visible while loading). |

## Known limitations

- "See all recent activity" and the Feed shortcut open the feed (RN-07);
  announcements (RN-09) and alerts (RN-10) open their own screens. Events,
  documents and members are placeholders until their stages are built.
- Posts on the home show `author_display_name` only. Uploaded avatars are not
  in the feed functions yet (see `profile.md`).
- No offline cache: after an app restart without a network, the home shows the
  offline state rather than old content.
- No real-time updates. Content refreshes on pull, on return to the screen, and
  on reload.

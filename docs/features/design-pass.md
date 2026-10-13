# Design Pass: Feed, Hub, Discover, Profile, Stories

The app was restyled to match the four reference screens (Home feed, Community
hub, Discover, Profile), and stories were added (see [`stories.md`](stories.md)).
Every number on screen comes from the server. Where the backend has no data
for an element of the mockups, the element was **left out rather than faked**
(see "Not built" below).

- **Migration 27:** stories, plus `community_stats()` and `my_profile_stats()` (see [`stories.md`](stories.md))
- **Tests:** `apps/mobile/src/features/design/design.test.tsx` (11); stories (13 + 3); existing suites updated

## Navigation

| Before | Now |
|---|---|
| Home · Communities · Marketplace · Alerts · Profile | Home · Communities · Discover · Market · Profile, with a floating **+** above the bar |

- **Alerts left the tab bar** (as in the mockups). Alerts are still reachable:
  - from the hub's Alerts tile and Alerts section;
  - from the feed, where urgent and emergency alerts stay pinned above the posts;
  - from notifications;
  - from `communione://alerts`, which now opens the hub's Alerts list.
- **The floating "+"** (bottom right, just above the tab bar) opens the **Create** sheet (root modal).
  It shows on the main screen of Home, Communities and Discover only, never over a post, an editor or a detail screen.
  The sheet offers:
  - Post, Photos and Story need `posts.create`;
  - Event needs `events.create`;
  - Alert needs `alerts.create`;
  - Announcement needs `announcements.create`;
  - Document needs `documents.upload`;
  - Join a community and Create a community are always offered.

  Actions show only with their permission in the current community, and every
  screen is authorized again by the database.
- New root screens: `Create`, `StoryComposer`, `StoryViewer`.
- `openInCommunity()` (`src/navigation/openInCommunity.ts`) is the shared way
  for root screens to open a screen of the current community (`popTo('App')`,
  never a second copy of the tabs).

## Screens

**Home (feed)**
- Header: "Good morning, Ada" (from the device time and the profile's first name), the community name (tap to switch), a round notifications button with the unread badge, and a chevron to choose a community.
- Stories row.
- "Share something with {community}…": an avatar and a pill. Below it, Photo / Event / Alert quick actions, each shown only with its permission.
- Pinned alerts: urgent ones as a soft red banner. An emergency in force keeps the solid red block.
- Filter pills: **Latest** (newest first), plus Hidden and Deleted for moderators.
- Post card:
  - avatar with tinted initials;
  - name, then "{community} · {time}" and a members-only icon;
  - the text above the photos, with **#hashtags** highlighted (display only);
  - photos with the 1/N counter, Like and Comment.

**Communities (hub)**
- "YOUR COMMUNITY", the name (tap to switch), the description and a **+** (Create).
- Welcome card:
  - the cover photo, darkened for legibility, or the brand colour;
  - the logo and "{TYPE} · PRIVATE COMMUNITY";
  - "Welcome home, Ada";
  - "{N} members are building a stronger community together." (`community_stats`);
  - "You are a Member".
- Six tiles with counts from `community_stats()`:

  | Tile | Count |
  |---|---|
  | Feed | posts today |
  | Announcements | current |
  | Alerts | active |
  | Events | upcoming |
  | Documents | files the user can see |
  | Members | people (opens the member directory, RN-14) |

  A count the user may not see is null and **not shown**. The count is also
  exposed as the tile's accessibility value.
- Then the existing sections: Alerts, Announcements, Upcoming events and Recent activity.

**Discover**
- "FIND YOUR PEOPLE / Discover communities" hero with a search field.
- "Have an invitation?" (join with a link or code) and "Start a community".
- "Your communities" cards (type, name, role) with Open / Switch, using the server-checked switch.

**Profile**
- Brand cover band, overlapping avatar, name, "{role} · {current community}".
- "Joined {Month Year}" (the account's creation date).
- Edit profile, the bio, then the stats row: Posts, Events joined, Communities (`my_profile_stats()`, the user's own numbers only).
- Private phone card and Account & security, as before.

## Design system additions

- `tints`: soft colour pairs (blue, amber, red, purple, green, teal) for tiles, initials avatars and the alert banner. Each `fg` passes WCAG AA on its `bg` (`contrast.test.ts`).
- `storyRing`: the unseen-story ring (logo teal).
- `media`: black backdrop and white text for the full-screen story viewer, in both themes.
- `Avatar` initials get a stable tint per name.

## Not built (the mockups show them, the backend has no data yet)

| Mockup element | Why not | What it needs |
|---|---|---|
| "For you" and "Curated" feed tabs | there is no ranking or curation; only newest-first exists | a ranking or curation model |
| Public community search, categories, "Nearby", "Recommended", "Join community", favourites | communities are private and invitation-only; there is no location or interest data | an opt-in public listing, a join policy, location and interests (a privacy decision) |
| Profile location, "Connections", Activity / Posts / Saved tabs | no location field, follow model, saved posts or activity feed | new tables and policies |
| "Manage community" on the hub card | no community settings screen yet | a settings stage |
| "2 unread" on Announcements, "42 new" on Feed | no per-user read tracking | read receipts |
| The mockups' geometric typeface | system fonts are used; a custom font would mean bundling one | a font asset (licence) |

## Unchanged security

- The app shows or hides controls from permissions. Every write is authorized by RLS, triggers and RPC checks.
- Counts come from `SECURITY DEFINER` functions that check membership and apply the same visibility rules as the lists.
- No public URLs for private content: story and post pictures and documents use signed URLs. Community logos and covers stay in their public bucket, as before.

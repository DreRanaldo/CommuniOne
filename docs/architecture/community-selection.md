# Community Selection (RN-04)

How the mobile app handles users who belong to several communities: which
community is "current", how it is chosen, restored and validated, and why the
app's choice never grants access by itself.

- **Code:** `apps/mobile/src/features/communities/`
  - `CurrentCommunityProvider.tsx`: the app-level state
  - `selection.ts`: the rules, as pure functions
  - `components/`: cards, list, switcher button, logo, notice
  - `screens/`: switcher, picker, hub
- **Backend:** no new migration. It uses `my_communities()` (Stage 3) and the
  existing RLS.
- **Tests:**
  - `apps/mobile/src/features/communities/communities.test.tsx` (25)
  - `apps/mobile/src/features/communities/selection.test.ts` (15)
  - `tests/services/community-selector.test.ts` (7, real Supabase)

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the current community lives | One React context, `CurrentCommunityProvider`, mounted for the signed-in user above navigation | Screens call `useCommunity()` instead of passing ids through props or route params. No state library is needed for one value. |
| What can be selected | Only a row of `services.communities.listMine()` (the server's `my_communities()`), with an **active membership** in an **active community** | The server builds that list for the session user only. A pending, suspended or archived membership is listed and explained, but cannot be entered. |
| Source of an id | Never trusted. A stored id, a link id or a tapped card is checked against a list freshly fetched from the server before use | A client-chosen community id is not authorization. |
| Default | The stored selection if still valid; else the only selectable community; else the user picks | No guessing when there is a real choice. |
| Navigation | The **Home** tab is the current community's hub. The header shows its logo and name and opens the **switcher** (a modal). Switching remounts the hub stack | It is always clear which community you are in, and no screen of the previous community stays open. |
| Persistence | `{ userId, communityId }` in the device keychain (`secureStorage`), key `communione.currentCommunity` | It survives restarts. It is ignored for any other account on the device. It is only a preference: it is re-validated on every start. |
| Search | Client-side filter over the loaded list (name, type, role; case- and accent-insensitive), shown from 4 communities | `my_communities()` already returns every membership. A server-side search can replace `filterCommunities()` later without changing the screens. |

## Validation points

| When | What happens |
|---|---|
| App start / sign-in | `listMine()`, then the stored id is kept only if it is in the list and selectable. If it is not, the selection is dropped with a notice. While offline at start, nothing is opened (error state with retry): the stored id is not used without the server. |
| Tapping a card | `select(id)` fetches `listMine()` again and accepts the id only if it is still selectable. |
| `communione://communities/<id>` | Malformed: "That community link is not valid." (no request). Not a membership, or a community that does not exist: "You don't have access to that community." The same message is used for both, so a link cannot tell whether a community exists. Not selectable (pending, suspended, archived): the reason is shown. The current community is unchanged. |
| Opening the switcher | `listMine()` is re-checked. |
| Returning to the foreground | `listMine()` is re-checked, at most once a minute. |
| Lost access (removed, suspended, archived) | The community is dropped, with "You no longer have access to …". If exactly one selectable community remains it opens; otherwise the user picks. |

## Why this is safe

The app's selection decides **what to show**, never **what is allowed**:

- `my_communities()` is `SECURITY DEFINER` and filters on
  `private.current_active_user_id()`. It returns only the caller's own pending,
  active and suspended memberships, never another user's.
- Every community request (feed, events, documents, …) is checked by RLS with
  `has_community_permission(community_id, …)` on the server. If the app sent a
  community id the user cannot access, the result would be empty or `NOT_FOUND`,
  the same as for a community that does not exist.
- `my_community_permissions()` returns nothing for pending, suspended, departed
  or archived memberships, and for foreign ids. `tests/services/community-selector.test.ts`
  pins this down.
- Role names on the cards are display labels. No decision is made on them.
- A revoked session cannot list memberships. The database answers
  "authentication required", and the app signs out ("Your session has expired").

## UX

- **Cards:** logo (https `logo_url`) or initials, name, type ("Residential",
  "Church", …), the user's role(s), and a reason when the community cannot be
  entered. The current community has a highlighted border, a check mark and
  "Current", and `accessibilityState.selected`. Unavailable cards are disabled.
- **Hub header:** "Switch community. Current community: {name}" (logo, name, chevron).
- **Empty state:** "No communities yet" with "Join with an invitation".

## Known limitations

- Creating and joining (RN-05) end with `select(newCommunityId)`, which
  re-fetches the memberships from the server, so the new community appears and
  opens at once.
- Community-scoped data screens (feed, events, …) are placeholders. When they
  arrive, they read `useCommunity().community_id`, and their own requests are
  authorized by RLS. If one of them gets `NOT_FOUND` / `FORBIDDEN` for the
  current community, it should call `refresh()`.
- Permissions per community (`myPermissions`) are not loaded yet; nothing in the
  UI is gated on them at this stage.
- `my_communities()` is typed by the generator with non-null columns; `logo_url`
  can be `NULL` and is handled as such.

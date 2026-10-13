# Member Directory (RN-14)

The current community's members: who they are, their roles and when they
joined. People can search by name and open a member's community profile.
**Privacy is enforced by the database.** The app receives only
community-profile fields, so there is nothing private for it to hide.

- **Migration 28:** `supabase/migrations/20261011002800_member_directory.sql`
  - `list_community_members()`, `get_community_member()`, `private.member_display_name()`
  - no table, policy or privilege change
- **Service** (`services/memberships`):
  - `directory({ communityId, query?, limit?, cursor? })` → `Page<DirectoryMember>`
  - `member(communityId, userId)` → `MemberProfile`
  - a new cursor kind, `arg`: values that are only ever bound RPC arguments, such as names
- **App:** `apps/mobile/src/features/members/`
  - `screens/MembersScreen`: count, search, list, paging
  - `screens/MemberProfileScreen`
  - `MemberItem`, `useMemberDirectory`, `memberRules`
  - Post authors in the feed open their member profile.
- **Tests:**
  - `supabase/tests/database/029_member_directory.test.sql` (pgTAP, 31)
  - `tests/services/members-ui.test.ts` (8, real Supabase)
  - `apps/mobile/src/features/members/members.test.tsx` (12)

## What is shown

| Field | Directory | Profile | Notes |
|---|---|---|---|
| Display name | ✓ | ✓ | Else first and last name; else "Member" |
| Avatar | ✓ | ✓ | Signed URL (private `avatars` bucket), 1 hour |
| Roles | ✓ | ✓ | **Only with `roles.view`** in that community; otherwise `null` and not shown |
| Joined (membership date) | ✓ | ✓ | |
| "You" | ✓ | ✓ (edit link) | |
| First / last name, bio | – | ✓ | Community profile fields |
| **Phone number** | ✗ | ✗ | `profile_private`, owner-only RLS (migration 19); never read by these functions |
| **E-mail address** | ✗ | ✗ | `auth.users`; never exposed |
| Account status, timestamps | ✗ | ✗ | Not returned |

## Who sees whom

- The caller needs **`members.view` in that community** (an active membership).
  Pending members, outsiders and signed-out clients are refused (`42501` → `FORBIDDEN`).
- The functions return only **active members with an active account** of that community.
  - Pending, suspended, rejected and departed people are left out.
  - So are deactivated accounts.
  - Members of other communities never appear, not even through search.
- A profile request for someone who is not an active member of that
  community returns nothing (`NOT_FOUND` in the service), even if both
  people share another community.

## Search

- Searches **names only**: display name, first name and last name. It never
  looks at phone numbers or e-mail addresses.
- Case-insensitive and trimmed, at most 100 characters. Characters like `%` and
  `_` are matched literally, not as wildcards.
- Searches only the given community.
- The app waits 300 ms after typing before searching.

## Paging

- Ordered by name: members without a name come last, then by user id.
- The keyset cursor is `(unnamed, lower(name), user_id)`, 30 per page.
- The name part of the cursor is only ever a bound RPC argument, never part of
  a PostgREST filter string, hence the separate cursor kind.

## Why functions rather than the profiles table

`profiles` are readable by anyone who shares *any* community with the person
(`private.can_view_profile`, Stage 1 rule), including their account status.
The directory needs a narrower rule (this community, active only) and a fixed,
minimal set of columns. The two `SECURITY DEFINER` functions check the
permission explicitly and return only the fields above.

## Known limitations

- No member management in the app yet (approve, suspend, remove, roles). The
  service operations exist (`memberships.approve` and the others).
- No "shared communities" or messaging.
- Sorting is by name only.
- Profiles are still readable through the `profiles` table by co-members
  (names, bio, avatar, account status), per the Stage 1 rule. The app does not
  use that path for the directory.

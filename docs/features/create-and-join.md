# Creating and Joining Communities (RN-05)

The mobile workflows for starting a community and for joining one with an
invitation, and the backend pieces they use.

- **Migration:** `supabase/migrations/20261011002400_community_media_and_invitation_preview.sql`
- **Services:**
  - `communities.create` (existing), `communities.uploadImage`, `communities.removeImage`, `communities.imageUrl`
  - `invitations.preview`, `invitations.redeem` (existing)
  - See [`../api/README.md`](../api/README.md).
- **Screens:** `apps/mobile/src/features/communities/create/` and `.../join/`
- **Tests:**
  - `supabase/tests/database/025_community_media_and_invitation_preview.test.sql` (pgTAP, 43)
  - `tests/services/create-join.test.ts` (real Auth, Data API and Storage, 15)
  - `apps/mobile/src/features/communities/createJoin.test.tsx` (21) plus rule tests for
    form validation, slugs and invitation errors (9)

## Create a community

**Entry points:** "Create a community" under the community list (Home with no
community, and the switcher).

| Field | Rules |
|---|---|
| Name | Required, ≤ 120 characters |
| Description | Optional, ≤ 2000 characters |
| Type | Residential, Church, School, Club, Association, Organization, Other |
| Time zone | Defaults to the device's. Must be an IANA name (e.g. `America/Chicago`), checked on the device and by the database (`pg_timezone_names`). |
| Logo | Optional. Square, resized to 512 px JPEG, ≤ 2 MiB. |
| Cover image | Optional. 16:9, resized to 1600 × 900 JPEG, ≤ 5 MiB. |

**What happens:**

1. `services.communities.create(...)` calls the existing `create_community()`
   database function. In one transaction it creates the community, its default
   roles, the caller's active membership and the Owner role assignment. The app
   decides nothing about ownership, membership or roles: it never writes
   `memberships`, `membership_roles` or `roles`, and has no privilege to do so.
   The tests assert this.
2. The community's **address** (`slug`, unique) is generated from the name plus
   a random suffix (`maple-grove-hoa-x7k2`). It is retried with a new suffix if
   taken (`CONFLICT`), up to 3 times.
3. Logo and cover are uploaded with `communities.uploadImage`. The storage policy
   and RLS allow this only for `community.update` holders, which the new Owner
   is.
4. The app selects the new community (re-checked with `my_communities()`) and
   opens its hub.

If an image upload fails after the community was created, the screen says so
("…was created, but the logo could not be uploaded. You can add it later.") and
offers to open it. Nothing is created twice. The creation limit (10 per user per
24 hours) is shown as a `RATE_LIMITED` message.

### Community logo and cover storage

**Decision: a public bucket, `community-media`.** Logos and covers are community
branding, not personal data. Someone previewing an invitation must see them
before joining, and could not be given a signed URL, because signing requires
read access and they are not a member yet.

| Rule | Mechanism |
|---|---|
| Paths cannot be guessed | `{community_id}/{random uuid}.{ext}`. Non-members cannot list the bucket (`community_media_select` requires `community.view`). |
| Upload and delete | `community.update` in that community (`community_media_insert` / `_delete`) |
| No overwriting or moving | No UPDATE policy |
| A community can only point at its own uploaded files | `communities_check_media` trigger |
| Current files cannot be deleted | The delete policy excludes paths in use |
| Old files go away | Replacing or removing deletes the previous file. Leftovers are listed by `list_community_media_to_purge()` (service role, scheduled). |

## Join with an invitation

**Entry points:**
- a link, `communione://join?token=ci_…`, which opens the Join modal;
- "Join with an invitation" under the community list, where the user pastes a
  code or link.

1. **Validate.** The token's format is checked on the device (`parseInvitationToken`):
   a malformed code never leaves the device. Then `services.invitations.preview`
   calls `preview_invitation()`, which applies the same checks as redemption and
   consumes nothing.
2. **See the community.** Shown before joining:
   - cover, logo, name and type;
   - member count and description;
   - "Invitation valid until …".
3. **Accept.** `services.invitations.redeem` calls `redeem_invitation()`
   (atomic, row-locked). The user becomes an active member with the default
   Member role.
4. The app selects the community and opens its hub.

| Situation | What the user sees |
|---|---|
| Already a member | "You're already a member", and "Open {community}". The invitation is not used. |
| Suspended member | "Membership suspended. An invitation cannot lift a suspension." No join button. |
| Pending / left / rejected | Normal join (the invitation re-admits them) |
| Expired or used up | "Invitation expired" |
| Revoked | "Invitation revoked" |
| Creator lost the right to invite, or the community is archived | "Invitation no longer valid" |
| Unknown token | "Invitation not found". It reveals no community. |
| Revoked between preview and accept | `redeem_invitation()` re-checks it: "Invitation revoked". The user does not join. |
| Network problem | "Couldn't check the invitation", with "Try again" |

**Token secrecy.**
- A token from a link is removed from the navigation route as soon as it is read.
- A pasted code is cleared from the field once checked.
- The token is kept only in memory for the accept step.
- It is never displayed back, stored or logged; the service layer logs operations
  and error codes, not arguments.

## Future join methods

- **QR invitations:** the QR code would carry the same link,
  `communione://join?token=…`. Scanning it with the system camera already opens
  the Join modal through the deep link. An in-app scanner only needs to navigate
  to `JoinCommunity` with `{ token }` (or call `parseInvitationToken` on the
  scanned text). The validate → preview → accept flow is unchanged. Creating
  invitations and showing them as QR codes belongs to the member-management
  stage (`invitations.create` exists). No camera dependency was added.
- **Community search / directory:** not built. The backend deliberately has no
  way to find communities you do not belong to: RLS hides them, and
  `preview_invitation()` requires a token. A directory would need a new opt-in
  setting (e.g. `discoverable`), a database function exposing only listed fields
  of discoverable communities, and a join-request flow (memberships `pending` →
  approved by `members.approve`). The switcher's search (`filterCommunities`)
  covers only your own communities.

## Security summary

- Ownership, membership and roles are created only by `create_community()` and
  `redeem_invitation()`. The app has no INSERT privilege on memberships or role
  tables.
- Image uploads are authorized by storage policies (`community.update`) and the
  `communities_check_media` trigger. A Member gets `FORBIDDEN`; a non-member
  gets `NOT_FOUND`.
- The preview and redemption functions give the same answers. An invitation is
  judged by the server at accept time, not by the preview.
- Rate limits: community creation 10 per 24 hours; redemptions 30 per hour
  (Stage 12).

# Mobile Admin Tools (RN-16)

The mobile app has a small set of essential admin tools for the current
community. The full admin dashboard is the Admin Web application; this stage
does **not** recreate it.

- **Migration 30:** `supabase/migrations/20261011003000_alert_removal_requires_manage.sql`
- **Service:**
  - `memberships.get(membershipId)` is new.
  - `Member.communityId` is new.
  - The `CreatedInvitation`, `InvitationSummary` and `Role` types are now exported.
  - Existing calls used: `memberships.list / approve / reject / suspend / reinstate / remove`, `roles.list / assign / unassign` and `invitations.create / list / revoke`.
- **App:** `apps/mobile/src/features/admin/`
  - `adminRules.ts`: which tools and actions to show, from permissions.
  - `useMembershipList.ts`
  - `screens/AdminScreen`, `AdminMembersScreen`, `AdminMemberScreen`, `InvitationsScreen`, `ModerationScreen`
  - Feed timeline: `apps/mobile/src/features/feed/timeline.ts`
- **Tests:**
  - `apps/mobile/src/features/admin/admin.test.tsx` (33)
  - `apps/mobile/src/features/feed/timeline.test.ts` (4)
  - `tests/services/admin-ui.test.ts` (9, real Supabase)
  - `supabase/tests/database/014_alerts.test.sql` (+3 for migration 30)
  - `tests/integration/alerts.test.mjs` (updated for migration 30)

## Where it lives

Admin controls are kept apart from the normal member experience:

- **Hub:** a shield button (`hub-admin`, "Admin tools") next to ⚙. It is shown only when the user has at least one tool.
- **Community settings:** an "Administration → Admin tools" row (`settings-admin`), shown under the same condition.
- **Admin tools screen**, grouped as follows:

| Group | Tool | Shown with |
|---|---|---|
| People | Members and requests | `members.approve`, `members.suspend`, `members.remove` or `roles.manage` |
| People | Invite members | `members.invite` |
| Content | New announcement | `announcements.create` |
| Content | New alert | `alerts.create` |
| Content | Manage events | `events.create` or `events.manage` |
| Content | Manage documents | `documents.upload` or `documents.manage` |
| Moderation | Hidden and deleted posts | `posts.moderate` |
| Community | Community profile | `community.update` |

Content tools open the existing screens (editors, events, documents). Those
screens already show their management controls from permissions.

With the seed role templates:

| Role | Tools |
|---|---|
| Owner | all, including role switches |
| Admin | all, except role switches (no `roles.manage`) |
| Moderator | Members (suspend and reinstate only), Moderation |
| Member | none: no shield and no settings row |

## Permissions, not roles

Every tool and action is chosen from the user's **permission keys** in the
current community (`my_community_permissions`). The app never checks a role
name: a custom role holding only `members.invite` gets exactly "Invite
members" (tested).

These choices are **hints only**. Each screen checks its permission again and
shows "Not available" without it. Every action is then authorized by the
database:

| Action | Database rule |
|---|---|
| See requests or suspended members | RLS (migration 10): non-active memberships need `members.approve`, `members.suspend` or `members.remove`; active ones need `members.view` |
| Approve or decline a request | `private.enforce_membership_update`: `members.approve` |
| Suspend or reinstate | `members.suspend` |
| Remove | Delete policy: `members.remove`, never yourself |
| Any of the above | The **cover rule**: you must hold every permission the member holds, so a Moderator cannot touch an Admin and an Admin cannot touch the Owner |
| Give or take a role | `roles.manage`, never on your own membership, and only roles whose permissions you hold (anti-escalation, Stage 1) |
| Create, list or revoke invitations | `members.invite` (SECURITY DEFINER functions; the list is empty without it) |

Refusals are explained in plain words. For example: "You can't do this for
this member… they hold permissions you don't have (for example an Owner)."

## Members and requests

- **Tabs:**
  - Active;
  - Requests (`members.approve`);
  - Suspended (`members.suspend` or `members.remove`).

  The lists are paged, oldest first.
- **Member screen:** the membership is read from the server (`memberships.get`) and must belong to the **current community**. A membership of another community shows "This member is not in this community", even where the user also manages that community.
- **Actions, by status:**

  | Status | Actions |
  |---|---|
  | pending | Approve; Decline (asks first) |
  | active | Suspend (asks first) |
  | suspended | Reinstate |
  | pending, active or suspended | Remove (asks first) |

- **No actions on yourself.** The screen says to leave from Community settings instead.
- **Roles:** with `roles.manage`, an active member's roles appear as switches. Without it, the role names are shown read-only.
- **What each action does to roles:**
  - Approving assigns the default role (Member).
  - Declining removes all roles.
  - Suspending keeps them.
- **Requests are rare.** Invitations admit people at once. Pending memberships come only from backend or admin-web flows, which is why the tab exists.

## Invitations

- **Choices:** expiry (1 day, 7 days or 30 days) and uses (one person, up to 10, or no limit).
- **The code is shown once.** After "Create invitation", the code (`ci_` + 64 hex) and the link (`communione://join?token=…`) are shown a single time, with "Share invitation" (the system share sheet).
  - The server stores only a hash of the code.
  - The app never logs or stores it.
  - After "Done" the code is gone from the screen.
- **The list shows no codes.** Active invitations appear with "Expires … · Used n of m". Revoking one (asks first) stops it at once.

## Moderation

- **Removed from the feed.** The Hidden and Deleted filters are no longer offered there, so ordinary members have no view of hidden or deleted posts. Previously a member could open "Hidden" to see their own hidden posts.
- **Moderators** (`posts.moderate`) review them in Admin tools → "Hidden and deleted posts", where they can restore posts.
- **The database is unchanged.** It still returns hidden or deleted posts only to moderators and to the post's own author.

## Alerts: only managers take them down (migration 30)

**Who could remove an alert:**
- **Members** never could. They hold no `alerts.create` or `alerts.manage`.
- **Authors** holding `alerts.create` without `alerts.manage` (for example a custom "Alerter" role) could, before this stage, end, cancel and archive their own *published* alerts.

**Migration 30** adds the trigger `alerts_restrict_removal`. Any status change of
a non-draft alert now needs `alerts.manage` (Owners and Admins); otherwise the
database answers `42501`.

**What authors keep:**
- their drafts (edit, issue, discard);
- correcting the text of their published alert.

The app shows End, Cancel and Archive only to `alerts.manage` holders.

## Feed timeline

**What the Home feed shows, newest first:**
- posts;
- current announcements (up to 10);
- upcoming events (up to 10);
- active **info and warning** alerts (up to 20).

Extras are placed by when they were published. **Urgent and emergency** alerts
stay pinned above the feed and are not repeated in the list.

**How the extras are read:**
- Each kind comes from its own list function, so the database decides visibility.
- Rows of another community are dropped.
- A section that fails is left out and never blocks the posts.

While older posts remain to load, extras older than the oldest loaded post
wait, so the order does not jump when the next page arrives.

## Security notes

- **Hints only.** Hiding a control is never the protection. Every action above was tested by calling the service directly as an unauthorized user, and the backend refused it:
  - members;
  - moderators trying to remove or approve;
  - Admins trying to give roles or to touch the Owner;
  - users acting on another community.
- **The community comes from context.** The app takes it from `CurrentCommunityProvider`, never from input. A membership screen also checks the membership's own `communityId`.
- **No secrets in the app.** There is no service-role key or other secret, and invitation codes appear only once, on the screen of the person who created them.

## Not built

| Item | Why |
|---|---|
| Ownership transfer workflow | The backend has none. An Owner can give another member the Owner role, then leave. |
| Editing role permissions or creating custom roles | Admin Web (role templates are managed by the database) |
| Audit log viewer | Admin Web (`audit.view`) |
| Bulk actions, member search inside the admin list | Admin Web |
| Copy-to-clipboard for codes | It would need a new dependency. Codes are selectable text and can be shared. |

## Deploying

**Apply migration 30 to the hosted Supabase project** before shipping this app
version: `supabase db push`, or run it in the SQL editor.

Migrations 26 to 29, from earlier stages, must also be applied if they are not yet.

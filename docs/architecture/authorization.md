# Authorization Architecture

**Status:** Stage 1, implemented and tested. Identity tightened in Stage 2 (see
[`authentication.md`](authentication.md)).
**Decision:** Authorization is permission-based and community-scoped, and it is
enforced inside PostgreSQL with Row Level Security. Client applications are never
trusted to enforce it.

## The chain

```
user (private.current_active_user_id(): verified JWT + live session + active account)
  └─ membership          one per (community, user); must be status = 'active'
       │                 and the community must be status = 'active'
       └─ membership_roles     a membership can hold several roles
            └─ role            community-scoped (Owner, Admin, ... or custom)
                 └─ role_permissions
                      └─ permission.key   e.g. 'members.suspend'
```

A user holds permission **P** in community **C** if and only if:

1. they have a live session and an `active` account (Stage 2), and
2. they have a membership in **C** with `status = 'active'`, and
3. **C** has `status = 'active'`, and
4. at least one role assigned to that membership grants **P**.

A user's effective permissions are the union of all their roles in that one
community. Nothing carries over between communities. Owning Community A grants
nothing in Community B.

```
User A ─┬─ Community A ─ Owner     → 31 permissions in A
        ├─ Community B ─ Member    → 14 permissions in B
        └─ Community C ─ Moderator → 17 permissions in C
```

## The check: `public.has_community_permission(community_id, permission_key)`

```sql
select public.has_community_permission('…community uuid…', 'members.approve');
```

- Returns a boolean **for the current user only.** There is no user parameter,
  so a caller cannot ask about anyone else or impersonate them. The identity
  always comes from `private.current_active_user_id()`: the JWT's user, but only
  while their session still exists and their account is `active` (Stage 2).
- Returns `false` for anonymous callers, unknown communities, unknown keys,
  pending, suspended or departed members, suspended or archived communities, and
  (Stage 2) signed-out or revoked sessions and suspended or deactivated accounts.
- RLS policies use it, and clients can call it as an RPC (for example to decide
  what to show in a UI). The UI result is only a hint: the database enforces the
  same check again on every query.

**Application code must check permissions, never role names.** Wrong:

```ts
if (membership.role === 'admin') { … }
```

Right: call `has_community_permission(communityId, 'members.suspend')`, or
better, attempt the operation and let RLS decide.

## Why SECURITY DEFINER, and how it is kept safe

Policies on `memberships`, `membership_roles` and `role_permissions` need to know
the caller's permissions, and finding them out means reading those same tables.
If the check ran with the caller's privileges, RLS would apply again inside the
check, which recurses forever (or quietly returns the wrong answer). So the
permission lookup runs as the table owner, which bypasses RLS for that lookup
only.

Every SECURITY DEFINER function:

- sets `search_path = ''` and schema-qualifies every object, so a hijacked
  search path cannot redirect it;
- takes the acting user from `private.current_active_user_id()` and never from a parameter;
- has no dynamic SQL and no side effects (except `create_community()`, which
  does one fixed set of inserts);
- returns only a boolean about the caller, except `create_community()`, which
  returns the community it just created;
- has `EXECUTE` revoked from `PUBLIC` and `anon`.

The internal helpers live in the `private` schema, which the Supabase Data API
does not expose, so clients cannot call them directly:

| Helper | Answers |
|---|---|
| `private.current_user_permission_ids(c)` | the caller's effective permission ids in `c` |
| `private.is_own_membership(m)` | is membership `m` the caller's own? |
| `private.current_user_covers_membership(m)` | does the caller hold every permission membership `m` holds? |
| `private.current_user_covers_role(r)` | does the caller hold every permission role `r` grants? |
| `private.can_manage_role_permission(r, p)` | can the caller add or remove permission `p` on role `r`? |
| `private.can_view_role(r)` | does the caller have `roles.view` in `r`'s community? |
| `private.can_view_membership(c, status)` | Stage 3: `active` needs `members.view`; any other status needs `members.approve`, `members.suspend` or `members.remove` |
| `private.can_view_membership_id(m)` | the same rule, looked up by membership id |
| `private.can_view_profile(u)` | does user `u` have a pending, active or suspended membership the caller may see? |
| `private.is_sole_role_manager(m)` | is `m` the only active membership with `roles.manage` in its community? |

## Anti-escalation rules

Holding `roles.manage` is not enough to hand out arbitrary power. On top of the
permission check, these rules apply:

1. **No self-assignment.** Nobody can add or remove roles on their own
   membership, Owners included.
2. **You can only grant what you hold.** To assign a role, or to add a permission
   to a custom role, the caller must already hold every permission involved.
   A delegated "Role Manager" who lacks `audit.view` cannot create or grant
   anything that includes `audit.view`.
3. **You can only act on people you cover.** To suspend, approve, remove or
   change roles for a member, the caller must hold every permission that member
   holds. So a Moderator cannot suspend an Admin, and an Admin (who lacks
   `roles.manage`) cannot suspend or remove an Owner.
4. **System roles are immutable from clients.** The default Owner, Admin,
   Moderator and Member roles cannot be renamed or deleted, and their
   permissions cannot be changed. Communities customize access by creating
   custom roles.
5. **Protected columns.** Column-level grants prevent clients from writing
   `communities.status`, `communities.slug`, `profiles.status`,
   `roles.is_system_role`, `memberships.community_id` and `memberships.user_id`.
6. **No orphaned communities.** The last active member holding `roles.manage`
   cannot leave.
7. **No direct membership creation.** Clients cannot insert memberships. The
   only paths are `create_community()` (for the creator) and
   `redeem_invitation()` (the joining user, Pre-Stage 12).

The default role tiers nest (Member ⊂ Moderator ⊂ Admin ⊂ Owner), so rule 3
produces the expected hierarchy without any hard-coded role ranking.

## Community creation

`public.create_community(p_name, p_slug, p_community_type, p_description, p_timezone)`
does all of the following in one transaction:

1. inserts the community with `created_by` set to the calling user;
2. copies each `role_templates` row into a community-scoped system role, along
   with its permissions;
3. creates an `active` membership for the caller;
4. assigns the caller the template flagged `assign_to_creator` (Owner).

If any step fails, the whole operation rolls back, and a test checks this.
Clients have no INSERT privilege on any of these tables, so this function is the
only way to create a community.

## Tenant isolation guarantees (all covered by tests)

- A user cannot read a community, its memberships, roles, role grants or member
  profiles unless they hold the right permission in that community. Guessing or
  changing a community UUID returns no rows.
- Owning one community grants nothing in another.
- A role from one community cannot be attached to a membership in another.
  Policies block it for clients, and composite foreign keys block it for
  everyone, including service-role code.
- Suspending a member, or a member leaving, removes all of their permissions
  immediately.

## Extending in later stages

- **New features** (posts, events and so on) add a `community_id NOT NULL`
  column and write RLS policies like
  `using (public.has_community_permission(community_id, 'posts.view'))`.
  For "own" permissions, combine with
  `author_id = (select private.current_active_user_id())`. Never use bare
  `auth.uid()` in new policies: it ignores sign-out and suspension.
- **New permissions:** insert them into `permissions` (and into
  `role_template_permissions` if they belong in defaults) in a migration. Decide
  explicitly whether existing communities' system roles should receive them,
  because template changes do not apply retroactively.

## Membership management (Stage 3)

The full client contract is in
[`../api/communities-and-memberships.md`](../api/communities-and-memberships.md).
The authorization-relevant points:

- **Visibility follows permissions.** `members.view` shows *active* members.
  Applications, suspensions and departures are visible only to members who
  manage membership (`members.approve`, `members.suspend` or `members.remove`).
- **Every status change is checked against a permission and the coverage rule**
  (`private.enforce_membership_update`). Nothing checks a role name.
- **Roles follow the membership lifecycle:**
  - admission assigns the community's flagged default role (no name lookup);
  - leaving or rejection removes all assignments, so re-admission can never
    silently restore old powers;
  - suspension keeps assignments, but they are inert while the membership is not
    active.
- **Communities are isolated.** Holding any permission in one community grants
  nothing in another. The tests attempt cross-community reads, updates, status
  changes, removals and role grants using real ids, and all of them fail.

## Content: posts, comments and reactions (Stage 5)

Details are in [`../features/posts.md`](../features/posts.md). The model is the
same as everywhere else, resolved per community through
`has_community_permission()`:

| Check | Implemented by |
|---|---|
| Can see a post | `private.can_view_post_row()`: published needs `posts.view`; hidden or deleted needs `posts.moderate` or authorship |
| Can see a comment | `private.can_view_comment_row()`: the post must be visible; non-published comments need `comments.moderate` or authorship |
| Can comment | `private.can_comment_on()`: `comments.create`, the post is published and visible, and any parent is published and on the same post |
| Can react | `private.can_react_to()`: the target is published and visible, plus `posts.view` |
| Edits and status changes | `private.enforce_content_update()` trigger: authors edit their own published content (`*.edit_own`) and delete it (`*.delete_own`); moderators hide, restore and delete (`*.moderate`) but never edit text; deleted is terminal |

- **Identity is never client-supplied.** Author and reaction-owner columns
  default to `private.current_active_user_id()` and are not writable.
- **Community scope is never client-supplied** for comments and reactions. It is
  derived from the target, and composite foreign keys bind it, so content from
  two communities can never be mixed.
- **The read RPCs add no privileges.** `list_community_posts`,
  `list_post_comments` and `get_reaction_summary` are `SECURITY INVOKER`, so RLS
  filters every row they return.
- **No coverage rule for content moderation.** A Moderator may hide an Admin's
  post. This is a deliberate difference from membership actions, which are
  hierarchical.

## Announcements (Stage 6)

Details are in [`../features/announcements.md`](../features/announcements.md).

| Check | Implemented by |
|---|---|
| Can see an announcement | `private.can_view_announcement_row()`: published or archived needs `announcements.view` or `manage`; draft or deleted needs `announcements.manage`, or authorship plus `announcements.create` |
| Can create | INSERT policy: `announcements.create` in the target community, author is the session user, status is draft or published |
| Can change a given announcement | `private.can_manage_announcement_row()`: `announcements.manage` (any announcement) or authorship plus `announcements.create` (your own) |
| What may change | `private.enforce_announcement_write()` trigger: allowed transitions, server-stamped dates, editing only while draft or published, deleted is terminal |

`create` versus `manage` is the only distinction, and it is made by permission
keys. Default Owners and Admins hold both; communities can grant `create`
alone to custom roles.

## Alerts (Stage 7)

Details are in [`../features/alerts.md`](../features/alerts.md).

| Check | Implemented by |
|---|---|
| Can see an alert | `private.can_view_alert_row()`: non-draft needs `alerts.view` or `manage`; a draft needs `alerts.manage`, or being the creator plus `alerts.create` |
| Can create | INSERT policy: `alerts.create`; **`emergency` additionally needs `alerts.manage`** |
| Can change a given alert | `private.can_manage_alert_row()`: `alerts.manage` (any) or creator plus `alerts.create` (own) |
| What may change | `private.enforce_alert_write()`: lifecycle transitions; emergency and post-draft severity changes need `alerts.manage`; all identity and time columns server-stamped |
| Audit log | `alert_events`: readable with `alerts.manage`; written only by trigger |

**Severity is an authorization input, so it is checked on the server.** The
emergency rule is enforced by both the policy and the trigger.

**Server-side identity:**

- The service role may execute `private.current_session_user_id()` and
  `current_active_user_id()`. They return NULL for it, so this grants nothing,
  but trusted writes such as the expiry sweep need it.
- Events written by server code record a NULL actor.

## Events and RSVPs (Stage 8)

Details are in [`../features/events.md`](../features/events.md).

| Check | Implemented by |
|---|---|
| Can see an event | `private.can_view_event_row()`: non-draft needs `events.view` or `manage`; a draft needs `events.manage`, or being the creator plus `events.create` |
| Can create or change an event | INSERT policy (`events.create`); `private.can_manage_event_row()` (`events.manage`, or creator plus `events.create`); lifecycle trigger |
| Can RSVP | `private.can_rsvp()`: the event is published and not started, and the caller has `events.view` in its community; only your own RSVP (`user_id` is the session user) |
| Capacity | `private.apply_rsvp_capacity()`, SECURITY DEFINER: locks the event row, counts under the lock, waitlists overflow. It applies to every writer, including server code. |
| Attendance totals | `public.get_event_attendance()`, SECURITY DEFINER: totals only, and only for events the caller can see |

- Members never see other people's `maybe` or `not_going` answers.
- `waitlisted` and the queue position are server-controlled.

## Notifications (Stage 9)

Details are in [`../features/notifications.md`](../features/notifications.md).

- **Ownership.** A notification is readable and manageable only by its
  recipient (`private.can_read_notification()`). There is no
  community-permission override, so not even a community Owner can read a
  member's notifications.
- **Access follows membership.** Community-scoped notifications of
  membership-requiring types are readable only while the recipient still has
  `community.view` in that community. Suspension or removal also cuts off old
  notifications.
- **Creation is a server privilege:**
  - clients have no INSERT grant;
  - the internal service (`private.create_notification`,
    `private.notify_community`) is executable only by other SECURITY DEFINER
    code;
  - `public.create_notification` is executable by the service role only.
- **Recipients are resolved by permission key** (e.g. `alerts.view`) through
  `private.community_members_with_permission()`. It computes permissions for
  arbitrary users, so it is internal only.

## Documents and file storage (Stage 10)

Details are in [`../features/documents.md`](../features/documents.md).

**Two independent layers:**

| Layer | Rules |
|---|---|
| Metadata | RLS on `documents` and `document_folders` (`private.can_view_document_row`, `private.can_manage_document_row`) plus the `enforce_document_write` trigger |
| Files | RLS policies on `storage.objects` for bucket `documents` |

- The file policies use `private.can_read_document_object`,
  `private.can_upload_document_object` and `private.can_delete_document_object`,
  and require an **exact** generated `storage_path` match.
- They never rely on the metadata layer having filtered anything.

| Permission | Allows |
|---|---|
| `documents.view` | Members-visible active documents |
| `documents.upload` | Upload; manage your own documents |
| `documents.manage` | Any document, restricted visibility, archive, folders |

**Client inputs that are never trusted:** file name, MIME type, size, storage
path, community and uploader. Every one is validated or derived on the server.

## Audit logs (Stage 11)

Details are in [`../features/audit-logs.md`](../features/audit-logs.md).

| Concern | Rule |
|---|---|
| Read | `audit.view` in the community (Owners and Admins by default); system events are for platform admins only |
| Write | Only database triggers, through `private.record_audit_event()`. The actor comes from `private.actor_user_id()` and is never a parameter. The service role can record only actorless system events. |
| Change | Nobody. Append-only triggers apply to every role; retention purge only (service role, at least 90 days). |

## Invitations (Pre-Stage 12 / Stage 4)

Details are in [`../features/invitations.md`](../features/invitations.md).

| Concern | Rule |
|---|---|
| Create | `create_invitation()`: `members.invite` in the community (Owners and Admins by default) |
| Read | `members.invite`; `token_hash` is never selectable; the raw token is shown once at creation |
| Revoke | `revoke_invitation()`: `members.invite` in the invitation's community; anything else looks like "not found" |
| Redeem | `redeem_invitation()`: any signed-in **active** account holding the token. The invitation row is locked, every check is re-done inside the lock, and the creator must **still** hold `members.invite` in an active community |
| Effect | Creates or re-activates the membership; the default Member role comes from the Stage 3 lifecycle trigger. Never reinstates a suspended member, never duplicates an active one |

## Account deletion and privacy (Pre-Stage 12)

- `delete_my_account()` has no parameters: it can only delete the caller. No
  community permission (not even Owner) allows deleting someone else's account.
- The only active role manager of a community with other members must transfer
  `roles.manage` before deleting their account (anti-orphan rule 6, extended).
- Creator columns become NULL only through the database's own FK action. The
  write triggers reject a client or service-role change of a creator column.
- Phone numbers are visible to their owner only. There is deliberately **no**
  permission that lets administrators read them (see
  [`privacy.md`](privacy.md)).
- Details: [`account-deletion.md`](account-deletion.md).

## Service layer and rate limits (Stage 12)

The apps call business operations in `services/` (see
[`service-layer.md`](service-layer.md) and [`../api/README.md`](../api/README.md)).
The service layer adds validation, uniform errors and pagination, but it
holds no privileges: it uses the anon key and the user's session, so every
rule in this document still applies, and a client that skips the service
layer gets exactly the same answers from the database.

- **Unknown or foreign ids look the same.** Services return `NOT_FOUND` for
  rows the caller cannot see. RSVPs to a missing, foreign or closed event are
  refused with one identical error before any event row is touched
  (migration 22).
- **Rate limits are authorization-adjacent rules in the database**
  (migration 21): per user and action, client requests only, `53400` when
  exceeded.

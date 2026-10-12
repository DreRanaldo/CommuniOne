# CommuniOne API (Stage 12 service layer)

The mobile app and the admin web app call **business operations** through the
service layer in [`services/`](../../services). They never write raw SQL and
never get unrestricted table access. Each operation validates its input, runs
as the signed-in user, and returns data or a typed `ServiceError`.

```ts
import { createClient } from '@supabase/supabase-js';
import { createServices, isServiceError, type Database } from './services/index.ts';

const supabase = createClient<Database>(EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY);
const api = createServices(supabase, { logger: myLogger });   // logger optional

await api.auth.signIn({ email, password });
const post = await api.posts.create({ communityId, body: 'Hello neighbours' });
const feed = await api.posts.list({ communityId, limit: 20 });
const more = await api.posts.list({ communityId, cursor: feed.nextCursor });
```

- Architecture, rate limits, transactions and the security review:
  [`../architecture/service-layer.md`](../architecture/service-layer.md).
- How permissions resolve: [`../architecture/authorization.md`](../architecture/authorization.md).
- Lower-level Data API / RPC reference (what each operation calls):
  [`communities-and-memberships.md`](communities-and-memberships.md) and the
  feature documents in [`../features/`](../features).

**Never create the client with the service-role key.** The service layer is
designed for the anon / publishable key plus the user's session, so that Row
Level Security applies to every call.

## Conventions

### Authentication

Every operation requires a signed-in user **except** `auth.signUp`,
`auth.signIn` and `auth.requestPasswordReset`. Identity always comes from the
Supabase session. No operation accepts a user id, role or permission from the
caller; inputs that try to set one (for example `authorUserId`) are rejected.

### Authorization

Permission keys below are checked by the database
(`has_community_permission()` in RLS policies, column grants, triggers and
SECURITY DEFINER functions) for the **authenticated user + community +
active membership + permission**. Role names are never used for decisions.
"Own" means the row's author or creator is the caller.

### Inputs

Inputs are plain objects with camelCase keys. Unknown keys are rejected
(`VALIDATION`, `details.field` = the key), so a client cannot believe it set a
field it is not allowed to set. Ids are UUIDs. Dates are ISO 8601 strings
**with a time zone** (or `Date` objects). Text is trimmed; lengths count
characters.

### Errors

Every failure is a `ServiceError` with `code`, a user-presentable `message`,
and `details` (`field` for validation, `retryAfterSeconds` for rate limits).
`error.toJSON()` is safe to send to a client; database internals (SQL, table,
constraint or policy names) are never included.

| Code | Meaning | Typical cause |
|---|---|---|
| `UNAUTHENTICATED` | Not signed in, session ended, wrong credentials | no session, revoked session, bad password |
| `FORBIDDEN` | Signed in but not allowed | missing permission, editing someone else's post, suspended membership |
| `NOT_FOUND` | Does not exist **or is not visible to you** | another community's id (indistinguishable from a missing one) |
| `VALIDATION` | Input breaks a rule | bad id, too long, wrong enum, expired invitation, bad cursor |
| `CONFLICT` | Clashes with current state | duplicate slug, already a member, transfer ownership first |
| `RATE_LIMITED` | Too many requests | per-user limits (see service-layer.md); `details.retryAfterSeconds` |
| `SERVER_ERROR` | Unexpected failure | logged (redacted); generic message to the client |

### Network failures and the `onError` hook

A request that never reached the server (offline, DNS, timeout) is a
`SERVER_ERROR` with `details.network: true` and the message "We couldn't reach
CommuniOne. Check your connection and try again." It is safe to retry.

`createServices(client, { onError })` calls `onError(error, operation)` after
every failure. The mobile app uses it to detect a session the server no longer
accepts (`UNAUTHENTICATED` from any operation other than sign-in / sign-up /
reset / link handling) and sign out locally.

### Pagination

List operations return `Page<T> = { items: T[], nextCursor: string | null }`.
Pass `limit` (1–50, default 20) and the previous page's `nextCursor` as
`cursor`. Cursors are opaque and validated; a tampered cursor is
`VALIDATION`. A non-null `nextCursor` means the page was full (the next page
may be empty). Lists that are naturally small return arrays with a hard cap
(noted below).

## Operations

Legend: **Perm** = required permission key in the community. "Errors" lists the
codes specific to the operation in addition to `UNAUTHENTICATED`,
`VALIDATION` and `SERVER_ERROR`, which any protected operation can return.

### auth

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `signUp(input)` | Create an account (no auth needed) | – | `{ email, password, displayName?, firstName?, lastName?, emailRedirectTo? }` → `{ userId, needsEmailConfirmation }` (identical for an address that already has an account) | `RATE_LIMITED`, network | Sends a confirmation email; profile created by the database |
| `signIn(input)` | Password sign-in (no auth needed) | – | `{ email, password }` → `Session` | `UNAUTHENTICATED` (one message for wrong password, unknown or unconfirmed email), `RATE_LIMITED` | Creates a session |
| `signOut(scope?)` | Sign out this device, others, or everywhere | – | `'local' \| 'others' \| 'global'` → `void` | – | Ends sessions immediately (server-side check) |
| `requestPasswordReset(input)` | Email a reset link (no auth needed) | – | `{ email, redirectTo? }` → `void` | `RATE_LIMITED`, `SERVER_ERROR` with `details.network` (never sent) | Email, if the account exists (never revealed) |
| `handleAuthRedirect(url)` | Complete an email link opened in the app (PKCE code exchange) | – | `communione://auth/callback?code=…` or `…/auth/reset-password?code=…` → `{ kind: 'signedIn' \| 'recovery' }` | `VALIDATION` (invalid / expired link, or opened on another device), network | Creates a session; `recovery` must be followed by `updatePassword` |
| `updatePassword(newPassword)` | Set a new password (also completes recovery) | signed in | password (8–72, letters and digits) → `void` | `VALIDATION` (rules, same as current password), `FORBIDDEN` (re-authentication needed) | Other sessions are kept unless signed out |
| `getMyProfile()` | Own profile | – | → `Profile` | `NOT_FOUND` | – |
| `updateMyProfile(patch)` | Edit own profile (active account) | – | `{ displayName?, firstName?, lastName?, bio?, avatarUrl? (https) }` → `Profile` | `FORBIDDEN` | – |
| `getMyPhone()` / `setMyPhone(phone \| null)` | Private phone number (visible to nobody else) | – | → `string \| null` / `void` | – | – |
| `getMyAccount()` | Account information (RN-03) | signed in | → `{ userId, email, emailConfirmedAt, createdAt, lastSignInAt, status }` | `UNAUTHENTICATED` | Asks Auth (`getUser`), not the cached session |
| `changePassword(input)` | Change password, re-checking the current one (RN-03) | signed in | `{ currentPassword, newPassword }` → `void` | `VALIDATION` (`currentPassword` incorrect; `newPassword` rules or unchanged) | Re-authenticates (new session), then updates the password |
| `uploadMyAvatar(input)` | Upload a new avatar (RN-03) | active account | `{ file: Blob \| ArrayBuffer \| Uint8Array, mimeType: 'image/jpeg' \| 'image/png' \| 'image/webp' }` (≤ 2 MiB) → `Profile` | `VALIDATION` (`file`, `mimeType`), `FORBIDDEN`, `SERVER_ERROR` | Stores `avatars/{userId}/{uuid}.{ext}`, sets `avatar_path`, removes the previous file |
| `removeMyAvatar()` | Remove the avatar (RN-03) | active account | → `Profile` | `FORBIDDEN` | Clears `avatar_path` and `avatar_url`, then deletes the file |
| `avatarUrl(profile, expiresInSeconds = 3600)` | Displayable avatar URL (RN-03) | signed in | `Pick<Profile, 'avatar_path' \| 'avatar_url'>` → `string \| null` | `VALIDATION` (expiry 60 s–24 h) | Signed URL for uploaded avatars; `null` when the caller may not see that profile |
| `deleteMyAccount()` | Permanently delete own account | – | → `void` | `CONFLICT` (only role manager of a community with other members: transfer ownership first) | Erases personal data, keeps community history as "Deleted User", audits `account.deleted`, signs out |

### communities

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | New community; caller becomes Owner | – | `{ name (≤120), slug ([a-z0-9-], 3–63), type?, description? (≤2000), timezone? }` → `Community` | `CONFLICT` (slug taken), `RATE_LIMITED` (10 per 24 h) | **Atomic:** community + Owner membership + default roles; audited |
| `get(id)` / `getBySlug(slug)` | One community | `community.view` (active member) | → `Community` | `NOT_FOUND` | – |
| `update(id, patch)` | Edit details and settings | `community.update` | `{ name?, description?, type?, timezone?, logoUrl?, coverImageUrl?, settings? (JSON ≤16 KB) }` → `Community` | `FORBIDDEN`, `NOT_FOUND` | Audited (`changed_fields`) |
| `listMine()` | Community switcher: my pending / active / suspended memberships | – | → rows (bounded by membership count) | – | – |
| `myPermissions(id)` | My permission keys, **for UI gating only** | – | → `string[]` | – | – |

### memberships

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `list(input)` | Members with profile and roles, oldest first | `members.view` (active); `members.approve/suspend/remove` (other statuses) | `{ communityId, status? = 'active', limit?, cursor? }` → `Page<Member>` | – (invisible rows are simply absent) | – |
| `getMine(communityId)` | My membership | – | → `{ id, status } \| null` | – | – |
| `approve(membershipId)` | Admit pending / rejected / left member | `members.approve` + covers target | → `Member` | `FORBIDDEN`, `NOT_FOUND` | Default role assigned; member notified; audited |
| `reject(membershipId)` | Reject a pending request | `members.approve` | → `Member` | as above | Notified; audited |
| `suspend(membershipId)` / `reinstate(membershipId)` | Remove / restore access | `members.suspend` + covers target | → `Member` | as above | Access changes immediately; audited |
| `remove(membershipId)` | Remove someone else | `members.remove` + covers target | → `void` | as above | Roles removed; audited |
| `leave(communityId)` | Leave a community | – | → `void` | `FORBIDDEN` (last role manager), `NOT_FOUND` | Audited |

"Covers target" = the caller holds every permission the target holds (anti-escalation).

### roles

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `list(communityId)` | Community roles (≤200) | `roles.view` | → `Role[]` | – | – |
| `assign(membershipId, roleId)` / `unassign(...)` | Give or take a role (e.g. hand over Owner) | `roles.manage`, not own membership, covers role and target | → `void` | `FORBIDDEN`, `NOT_FOUND` | Audited |

### invitations (inviteMember)

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | Shareable invitation | `members.invite` | `{ communityId, expiresIn? ('7 days'; 1 hour–30 days), maxUses? (1–10 000) }` → `{ invitationId, token (shown once), expiresAt, maxUses }` | `FORBIDDEN`, `RATE_LIMITED` | Only the token hash is stored; audited (never the token) |
| `list(input)` | Invitations (≤200), never tokens | `members.invite` | `{ communityId, includeInactive? }` → `InvitationSummary[]` | – | – |
| `revoke(invitationId)` | Stop an invitation | `members.invite` in its community | → `boolean` (false if already revoked) | `NOT_FOUND` | Audited |
| `redeem(tokenOrLink)` | Join a community | active account | token or link with `?token=` → `{ communityId, membershipId, status }` | `NOT_FOUND` (unknown), `VALIDATION` (expired, revoked, used up, no longer valid), `CONFLICT` (already a member), `FORBIDDEN` (suspended), `RATE_LIMITED` | **Atomic, row-locked:** membership + default role + usage count; audited |

### posts (and reactions)

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | New post | `posts.create` | `{ communityId, body (≤10 000) }` → `Post` | `FORBIDDEN`, `RATE_LIMITED` | – |
| `get(postId)` | One post | `posts.view` (hidden/deleted: author or `posts.moderate`) | → `Post` | `NOT_FOUND` | – |
| `list(input)` | Feed, newest first, with author, counts, my reaction | `posts.view`; `status` hidden/deleted: moderators | `{ communityId, status?, limit?, cursor? }` → `Page<FeedPost>` | – | – |
| `edit(postId, body)` | Edit own published post | `posts.edit_own` | → `Post` | `FORBIDDEN`, `NOT_FOUND` | Stamps `edited_at` |
| `delete(postId)` | Soft-delete own (or moderated) post | `posts.delete_own` / `posts.moderate` | → `Post` | as above | – |
| `hide(postId, reason?)` / `restore(postId)` | Moderate | `posts.moderate` | → `Post` | as above | Audited (`post.moderated`) |
| `react(input)` / `unreact(input)` | Add/change/remove my reaction | `posts.view` | `{ postId \| commentId, type }` | `FORBIDDEN` | – |
| `reactionSummary(input)` | Counts for ≤100 posts + ≤100 comments in **one** call | `posts.view` | `{ postIds?, commentIds? }` → rows | – | – |

### comments

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | Comment or reply on a published, visible post | `comments.create` | `{ postId, body (≤5 000), parentCommentId? }` → `Comment` | `FORBIDDEN`, `RATE_LIMITED` | Notifies the post / parent author |
| `list(input)` | Top-level comments or replies, oldest first | post visible | `{ postId, parentCommentId?, limit?, cursor? }` → `Page<ThreadComment>` | – | – |
| `edit` / `delete` / `hide` / `restore` | As posts | `comments.edit_own` / `delete_own` / `moderate` | → `Comment` | `FORBIDDEN`, `NOT_FOUND` | Moderation audited |

### announcements

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | Draft (or publish at once) | `announcements.create` | `{ communityId, title (≤200), body (≤20 000), priority? normal\|important, expiresAt?, publish? }` → `Announcement` | `FORBIDDEN` | Audited; publishing notifies members |
| `get(id)` | One announcement | `announcements.view` (drafts: managers / author) | → `Announcement` | `NOT_FOUND` | – |
| `edit(id, patch)` | Edit while draft / published | own + `announcements.create`, or `announcements.manage` | `{ title?, body?, priority?, expiresAt? }` → `Announcement` | `FORBIDDEN`, `NOT_FOUND` | Stamps `edited_at` |
| `publish` / `archive` / `delete` | Lifecycle | as edit | → `Announcement` | `FORBIDDEN`, `NOT_FOUND`, `VALIDATION` (transition) | Publish notifies; audited |
| `listCurrent(input)` | Published, not expired; important first | `announcements.view` | `{ communityId, limit?, cursor? }` → `Page` | – | – |
| `listHistory(input)` | Published / archived (managers: drafts, deleted) | `announcements.view` | `{ communityId, statuses?, limit?, cursor? }` → `Page` | – | – |

### alerts

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | Draft (or publish at once) | `alerts.create`; `emergency` needs `alerts.manage` | `{ communityId, title (≤160), body (≤5 000), severity? info\|warning\|urgent\|emergency, expiresAt?, publish? }` → `Alert` | `FORBIDDEN`, `RATE_LIMITED` | Outbox event + notifications on publish; audited |
| `get(id)` | One alert | `alerts.view` (drafts: managers / creator) | → `Alert` | `NOT_FOUND` | – |
| `edit(id, patch)` | Edit while draft / published | creator + `alerts.create`, or `alerts.manage` (severity after draft: manage) | `{ title?, body?, severity?, expiresAt? }` → `Alert` | `FORBIDDEN`, `NOT_FOUND` | `updated` event |
| `publish` / `cancel(reason?)` / `expire` / `archive` | Lifecycle | as edit | → `Alert` | as above, `VALIDATION` (transition) | Notifications / events; audited |
| `listActive(input)` | Active alerts, emergencies first | `alerts.view` | `{ communityId, limit?, cursor? }` → `Page` | – | – |
| `listMyActive()` | Banner across my communities (≤50) | – | → rows | – | – |
| `listHistory(input)` | Past alerts | `alerts.view` | `{ communityId, statuses?, limit?, cursor? }` → `Page` | – | – |

### events

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `create(input)` | Draft (or publish) | `events.create` | `{ communityId, title (≤200), startsAt, endsAt, description?, locationText?, timezone?, capacity? (1–100 000), publish? }` → `Event` | `FORBIDDEN` | Audited |
| `get(id)` | One event | `events.view` | → `Event` | `NOT_FOUND` | – |
| `edit(id, patch)` | Edit while draft / published | creator + `events.create`, or `events.manage` | partial of create → `Event` | `FORBIDDEN`, `NOT_FOUND` | Notifies attendees if time/place change |
| `publish` / `cancel(reason?)` / `complete` | Lifecycle | as edit | → `Event` | as above, `VALIDATION` | Cancel notifies; audited |
| `rsvp(id, status)` | going / maybe / not_going | `events.view`, event published and not started | → `{ status, waitlistedAt }` (`going` may come back `waitlisted`) | `FORBIDDEN` (also for unknown or foreign events: one answer) | **Atomic, row-locked:** capacity check + RSVP + waitlist |
| `cancelRsvp(id)` | Remove my RSVP | as rsvp | → `boolean` | – | Next waitlisted person promoted and notified |
| `attendance(id)` | Totals, places left, my status / queue position | `events.view` | → `Attendance` | `NOT_FOUND` | – |
| `listUpcoming(input)` / `list(input)` | Upcoming, or a calendar window | `events.view` | `{ communityId, from?, to?, statuses?, limit?, cursor? }` → `Page<Event>` | – | – |

### notifications

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `list(input?)` | My inbox, newest first | own only | `{ unreadOnly?, communityId?, includeArchived?, limit?, cursor? }` → `Page<Notification>` | – | – |
| `unreadCount(communityId?)` | Badge count | own | → `number` | – | – |
| `markRead(id)` / `markUnread(id)` / `archive(id)` / `delete(id)` | Inbox actions | own | → `boolean` (false: nothing changed / not yours) | – | Server-stamped times |
| `markAllRead(communityId?)` | Clear the badge | own | → `number` changed | – | – |

### documents

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `upload(input)` | Upload a file (two-phase) | `documents.upload`; `managers` visibility: `documents.manage` | `{ communityId, name (≤255, no slashes), mimeType (allow-list), file (Blob/bytes ≤ limit), folderId?, visibility? }` → `Document` | `FORBIDDEN`, `VALIDATION` (type, size, folder), `RATE_LIMITED` | **Atomic per phase:** reserve path → upload to that exact path → server checks real size/type → active; audited |
| `get(id)` | Metadata | visible document | → `Document` | `NOT_FOUND` | – |
| `getDownloadUrl(id, seconds?)` | Signed link (10–300 s) | visible, active/archived | → `string` | `NOT_FOUND` | – |
| `list(input)` | Newest first | `documents.view` (restricted: `documents.manage`) | `{ communityId, folderId?, rootOnly?, statuses?, limit?, cursor? }` → `Page<Document>` | – | – |
| `rename` / `move` / `setVisibility` / `archive` / `restore` / `delete` | Manage | uploader + `documents.upload`, or `documents.manage` (visibility, archive: manage) | → `Document` | `FORBIDDEN`, `NOT_FOUND` | Delete: file unreadable at once, purged later; audited |
| `listFolders(communityId)` (≤500) / `createFolder(input)` / `deleteFolder(id)` | Folders | view / `documents.manage` | → `Folder[]` / `Folder` / `void` | `FORBIDDEN`, `NOT_FOUND`, `CONFLICT` (duplicate name) | Deleting a folder moves its contents up |

### audit

| Operation | Purpose | Perm | Input → Output | Errors | Side effects |
|---|---|---|---|---|---|
| `list(input?)` | Audit trail, newest first (system events without `communityId`: platform admins) | `audit.view` | `{ communityId?, action?, actorUserId?, entityType?, entityId?, limit?, cursor? }` → `Page<AuditEntry>` | – | – |

## Not exposed on purpose

- No generic insert / update for memberships, role permissions, notifications,
  audit logs or communities' status. People join through `communities.create`
  and `invitations.redeem`; role permission sets come from the database's role
  templates.
- No service-role operations (notification creation, expiry sweeps, purges).
  They run in trusted backend jobs with the service-role key, never in an app.

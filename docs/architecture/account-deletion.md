# Account Deletion (Pre-Stage 12)

What happens when a user deletes their CommuniOne account: what is erased, what
the community keeps, and how the process is kept safe and atomic.

- **Migration:** `supabase/migrations/20261011001800_account_deletion.sql`
- **Tests:**
  - `supabase/tests/database/019_account_deletion.test.sql` (pgTAP, 39)
  - `tests/integration/account-deletion.test.mjs` (real Auth + Data API)
  - `tests/integration/alerts.test.mjs` (an alert creator deletes their account)

## Policy

| Data | On account deletion | Why |
|---|---|---|
| Auth account (`auth.users`, sessions, identities, refresh tokens, MFA) | **Deleted** | The person can no longer sign in; old tokens stop working at once |
| Profile (names, avatar, bio) | **Deleted** (`profiles` CASCADE) | Personal information |
| Uploaded avatar files (`avatars` bucket, RN-03) | **Deleted by the purge job** | Personal data. Storage files cannot be deleted from SQL, so once the profile is gone no row references the file, and `list_avatar_files_to_purge()` (service role, scheduled) lists it for deletion through the Storage API. Until then it is unreadable: the read policy requires a visible profile. |
| Phone number (`profile_private`) | **Deleted** (CASCADE) | Personal information |
| Memberships and role assignments | **Deleted** (CASCADE) | Personal records |
| Reactions, RSVPs, notifications, invitation redemptions, platform-admin grant | **Deleted** (CASCADE) | Personal records. Freed event places go to the waitlist as usual. |
| Posts and comments | **Kept**, `author_user_id = NULL` | Removing them would break other people's threads and the community record |
| Announcements, alerts (and their event log), events | **Kept**, creator columns NULL | Official and safety records |
| Documents and their Storage files, folders | **Kept**, `uploaded_by` / `created_by` NULL | Community files, not personal ones |
| Invitations the user created | **Kept**, `created_by` NULL, and **no longer redeemable** | An invitation is only as good as its creator's authority |
| Moderation / publication / cancellation stamps (`*_by`) | **Kept**, set to NULL | Records outlive the person |
| Audit log entries | **Kept**, unchanged | Security records; they contain only pseudonymous ids and never names, emails, phone numbers or content |
| Communities the user created | **Kept**, `created_by` NULL | A community outlives its creator |

**"Deleted User"**: every creator column above is nullable. The client renders
`NULL` as "Deleted User" (for example when embedding
`profiles!posts_author_user_id_fkey(display_name)` returns `null`).

## How to delete an account

```ts
// The signed-in user deletes their own account. No parameters.
const { error } = await supabase.rpc('delete_my_account');
// Then discard the local session:
await supabase.auth.signOut({ scope: 'local' });
```

| Error | Meaning |
|---|---|
| `42501` authentication required | No live session |
| `55000` transfer the ability to manage roles ... required in: *names* | The user is the only active member able to manage roles in a community that still has other active members. They must give another member the Owner role (or another role with `roles.manage`) first. |

Suspended accounts can still delete themselves (right to erasure): only a live
session is required, not an active account.

Operators can also delete an account server-side with the Auth admin API
(`auth.admin.deleteUser(id)`). The same database rules apply, because everything
is driven by the deletion of the `auth.users` row.

In the mobile app (RN-03), Profile → Account & security → Delete account explains
what is deleted and kept, asks the user to type `DELETE`, and calls
`services.auth.deleteMyAccount()`. The app deletes nothing itself. A `CONFLICT`
is shown as "Transfer your communities first".

## Safety

| Requirement | Mechanism |
|---|---|
| Nobody can delete another user's account | `delete_my_account()` takes **no user id**: it deletes `private.current_session_user_id()`, the validated session user. Clients have no DELETE privilege on `profiles` or `auth.users`. No community permission (not even Owner) allows it. |
| Atomic | One function, one transaction: the audit entry, the guard, and every CASCADE / SET NULL succeed together or nothing changes. |
| Communities are not orphaned | `profiles_guard_deletion` (BEFORE DELETE on `profiles`): if the user is the only active role manager of a community with other active members, the deletion is refused (`55000`). If they are its **last active member**, the community is archived instead. |
| History cannot be rewritten | The content write triggers allow a creator column to change only from a value to `NULL`, and only when the change is made by the database itself (the FK action runs as the table owner, never as `authenticated` / `anon`): `private.is_account_erasure()`. Clients have no column privilege on creator columns anyway; a test shows that even with a mistaken grant they could not clear one, and that even the service role cannot reassign authorship. |
| Audited | `account.deleted` system event (actor and entity = the pseudonymous user id, empty metadata). |
| Tokens stop working | Deleting `auth.users` deletes its `auth.sessions`; Stage 2 identity requires a live session row, so an unexpired access token resolves to nobody. |

## Foreign key review

Every foreign key that references a user (`auth.users` or `profiles`) was
reviewed. The `001_schema` pgTAP test pins the delete action of each one.

| Foreign key | Action |
|---|---|
| `profiles.id` → `auth.users` | CASCADE |
| `memberships.user_id` → `auth.users` / `profiles` | CASCADE |
| `profile_private.user_id`, `reactions.user_id`, `event_rsvps.user_id`, `notifications.user_id`, `invitation_redemptions.user_id`, `platform_admins.user_id` | CASCADE |
| `posts.author_user_id`, `comments.author_user_id` | **SET NULL** (was CASCADE) |
| `alerts.created_by`, `events.created_by`, `documents.uploaded_by` | **SET NULL** (was RESTRICT, which blocked deletion) |
| `announcements.author_user_id`, `document_folders.created_by`, `invitations.created_by`, `communities.created_by` | SET NULL |
| All `*_by` stamps (`published_by`, `cancelled_by`, `updated_by_user_id`, `moderated_by_user_id`, `revoked_by`, `granted_by`, `alert_events.actor_user_id`) | SET NULL |
| `audit_logs.actor_user_id`, `audit_logs.entity_id` | no FK (by design) |
| `storage.objects.owner` | no FK to `auth.users` in Supabase; files survive |

Before this milestone, the announcement-author and folder-creator `SET NULL`
actions were rejected by their own immutability triggers, so deleting such a
user failed. The erasure exception fixes that latent bug as well.

## Known limitations

- **Content bodies are kept.** A user who wants their posts' text removed must
  delete them first (soft delete keeps the body for moderation). A purge job for
  soft-deleted content is future work.
- **No grace period or undo.** Deletion is immediate. A "deactivate first,
  delete after N days" flow can be added later.
- **Some stamp columns have no index** (e.g. `alerts.published_by`). Their
  `SET NULL` scans the table during a deletion. This is acceptable at current
  scale; add indexes if account deletion becomes slow.
- **The client must sign out locally** after deleting; the server already
  rejects the old tokens.

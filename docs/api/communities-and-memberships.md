# API Contract: Communities and Memberships (Stage 3)

Clients (the Expo mobile app and the Next.js admin app) use the Supabase Data
API through `supabase-js`, signed in as the user with the anon or publishable
key. **Every rule below is enforced by Postgres (RLS, column grants, triggers
and SECURITY DEFINER functions).** UI checks are a convenience only.

Authorization always resolves to **permission keys** in the specific community
(see [`../architecture/authorization.md`](../architecture/authorization.md)).
Role names are display labels. Do not branch on them.

## Error semantics

| Situation | What the client sees |
|---|---|
| Not permitted to *see* a row (other community, missing permission) | The row is simply absent: `[]`, or `0` rows updated or deleted. **No error**, so nothing reveals that the row exists. |
| Allowed to see the row but not to perform this change | Postgres error `42501` (`insufficient_privilege`) with a message |
| Writing a column clients may never write (e.g. `status` on communities) | `42501` |
| Invalid membership status transition | `22023` |
| Constraint violation (bad slug, duplicate slug, bad type) | `23514` / `23505` |
| Invalid timezone | `22023` |
| Community creation limit reached | `53400` |
| Not signed in, signed out, revoked session, suspended account | `42501`, or empty results (see `authentication.md`) |

## Communities

### Create

```ts
const { data: community, error } = await supabase.rpc('create_community', {
  p_name: 'Maple Grove HOA',
  p_slug: 'maple-grove',              // lowercased and trimmed; 3–63 chars of [a-z0-9-]
  p_community_type: 'residential',    // residential | church | school | club | association | organization | other
  p_description: 'Residents of Maple Grove', // optional
  p_timezone: 'America/Chicago',      // optional, IANA zone, default 'UTC'
});
```

- Runs atomically. It creates the community and its four default system roles
  (Owner, Admin, Moderator, Member, with their permissions), plus an **active**
  membership for the caller holding the **Owner** role.
- Returns the new `communities` row.
- Limited to **10 new communities per user per rolling 24 hours** (`53400`).
- Direct `insert` into `communities` is refused (`42501`).

### Retrieve

```ts
// My communities, for a community switcher. Includes pending and suspended memberships.
const { data } = await supabase.rpc('my_communities');
// [{ community_id, name, slug, community_type, logo_url, community_status,
//    membership_id, membership_status, joined_at, role_names }]

// One community (requires community.view, i.e. an active membership)
const { data } = await supabase.from('communities').select('*').eq('slug', 'maple-grove').single();

// My effective permissions in a community, for showing or hiding UI
const { data: keys } = await supabase.rpc('my_community_permissions', { p_community_id });
```

- `my_communities()` returns only the caller's own `pending`, `active` and
  `suspended` memberships. Memberships the caller `left`, or that were
  `rejected`, are omitted.
- Reading the `communities` table directly requires `community.view`. Pending
  and suspended members, and non-members, get `[]`, even when they know the UUID.
- `my_community_permissions()` is empty unless the caller is an active member of
  an active community.
- There is no public community discovery yet.

### Update (requires `community.update`)

```ts
await supabase.from('communities')
  .update({ name, description, community_type, logo_url, cover_image_url, timezone, settings })
  .eq('id', communityId)
  .select();
```

- Writable columns: `name`, `description`, `community_type`, `logo_url`,
  `cover_image_url`, `timezone`, `settings`.
- `settings` must be a JSON object of at most 16 KiB.
- `status`, `slug` and `created_by` cannot be written by clients (`42501`).
- Without `community.update` the update affects 0 rows.

## Memberships

### Retrieve

```ts
// Member list with profiles and roles in one request
const { data } = await supabase
  .from('memberships')
  .select('id, status, joined_at, profiles(id, display_name, avatar_url), membership_roles(roles(id, name))')
  .eq('community_id', communityId);

// My own membership in a community
const { data } = await supabase.from('memberships')
  .select('id, status').eq('community_id', communityId).eq('user_id', myUserId);
```

| Membership status | Visible to |
|---|---|
| any status, if it is **your own** membership | you (while your session is live and your account is active) |
| `active` | members holding `members.view` |
| `pending`, `suspended`, `rejected`, `left` | members holding `members.approve`, `members.suspend` or `members.remove` |

Embedded `profiles` and `membership_roles` follow the same rules. With the
default roles, a Member sees active co-members, and Moderators and above also
see applications and suspended members.

### Change status

All status changes use the same call:

```ts
await supabase.from('memberships').update({ status }).eq('id', membershipId).select();
```

| Action | Transition | Who may do it |
|---|---|---|
| Approve an application | `pending` → `active` | `members.approve` |
| Reject an application | `pending` → `rejected` | `members.approve` |
| Re-admit | `rejected` / `left` → `active` | `members.approve` |
| Suspend | `active` → `suspended` | `members.suspend` |
| Reinstate | `suspended` → `active` | `members.suspend` |
| Leave | `pending` / `active` / `suspended` → `left` | the member themselves only |

Additional rules (all enforced in the database):

- **Coverage:** when acting on someone else, you must hold every permission they
  hold. A Moderator cannot suspend an Admin, and an Admin cannot suspend the Owner.
  Refused with `42501`.
- **Your own membership:** you cannot change its status except to `left`. You
  cannot reinstate or approve yourself (`42501`).
- **Last role manager:** the last active member holding `roles.manage` cannot
  leave (`42501`). Hand `roles.manage` to someone else first, for example by
  assigning them the Owner role.
- Anything not listed in the table is rejected with `22023`.
- **Role lifecycle:**
  - Admission (→ `active`) of a membership that has no roles assigns the
    community's default role for new members (Member).
  - `left` and `rejected` remove all role assignments, so re-admission starts
    again from the default role.
  - Suspension keeps roles, but they grant nothing while the membership is not
    active.
- `community_id` and `user_id` can never change (`42501`).

### Remove a member (requires `members.remove` and coverage)

```ts
await supabase.from('memberships').delete().eq('id', membershipId).select();
```

This deletes the membership and its role assignments. You cannot delete your own
membership; set it to `left` instead.

### Add a member

Clients **cannot** create memberships directly (`42501`). Memberships are created
by `create_community()` (for the creator) and, in a later stage, by invitation
and join-request flows.

## Roles (summary)

Role management works as in Stage 1:

| Operation | Requirements |
|---|---|
| View roles | `roles.view` |
| Create, edit or delete custom roles; assign or unassign roles | `roles.manage`; you must hold every permission involved; you cannot change your own assignments |
| System roles | Immutable from clients |

```ts
await supabase.from('membership_roles').insert({ membership_id, role_id }); // community_id is derived
await supabase.from('membership_roles').delete().eq('membership_id', id).eq('role_id', roleId);
```

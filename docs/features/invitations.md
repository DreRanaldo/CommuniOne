# Community Invitations (Stage 4, completed in Pre-Stage 12)

Shareable invitation codes or links that admit people to a community. An
invitation is the only way, besides creating a community, to become a member.

- **Migration:** `supabase/migrations/20261011002000_invitations.sql`
- **Tests:**
  - `supabase/tests/database/020_invitations.test.sql` (pgTAP, 48)
  - `supabase/tests/database/022_security_sweep.test.sql` (cross-tenant sweep, includes invitations)
  - `tests/integration/invitations.test.mjs` (real Data API, including 20 simultaneous redemptions)
  - `scripts/db/invitation-race.sh` (deterministic row-lock test and a 60-client burst; runs in CI)

## Data model

### `invitations`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `community_id` | FK → communities **RESTRICT**, immutable |
| `created_by` | The inviter (session user). FK → profiles **SET NULL**: if the inviter deletes their account the record stays but can no longer be redeemed |
| `token_hash` | SHA-256 (hex) of the token. **Unique, immutable, never readable by clients** |
| `expires_at` | 1 hour – 30 days after creation (default 7 days) |
| `max_uses` | NULL = unlimited, otherwise 1–10 000 |
| `use_count` | ≥ 0, ≤ `max_uses` (CHECK), can only increase |
| `status` | `active` → `expired` (time or uses exhausted) or `revoked` |
| `revoked_at`, `revoked_by` | Set by `revoke_invitation()` |
| `created_at`, `updated_at` | |

### `invitation_redemptions`

Who joined through which invitation: `invitation_id`, `community_id`,
`user_id` (CASCADE with the account), `membership_id` (SET NULL),
`redeemed_at`, `UNIQUE (invitation_id, user_id)`.

## Token security

| Property | How |
|---|---|
| Unguessable | `ci_` + 64 hex characters from two `gen_random_uuid()` values (244 random bits from the operating system's CSPRNG). Guessing is infeasible. |
| Stored hashed | Only `sha256(token)` is stored. A database leak does not reveal usable tokens. |
| Shown once | `create_invitation()` returns the raw token once. Nobody, including administrators, can read it back. A lost token is revoked and replaced. |
| Not readable | Clients have column-level SELECT on every column **except** `token_hash`; `list_invitations()` never returns it. |
| Not logged | Audit metadata never contains the token or its hash (tested). |
| Same answer for every failure | Unknown tokens return `P0002 invalid invitation`, without revealing whether a community exists. |

Share the token as a deep link, for example
`communione://join?token=ci_...`, or as a code to paste. Treat it like a
password: anyone holding it can join until it expires, is used up or is revoked.

## Authorization

| Action | Who | How |
|---|---|---|
| Create | `members.invite` in the community (Owners and Admins by default) | `rpc('create_invitation', { p_community_id, p_expires_in, p_max_uses })` |
| List | `members.invite` | `rpc('list_invitations', { p_community_id, p_include_inactive })` or `from('invitations').select('id, status, ...')` |
| Revoke | `members.invite` in the invitation's community | `rpc('revoke_invitation', { p_invitation_id })` |
| Redeem | Any signed-in user with an **active** account who holds the token | `rpc('redeem_invitation', { p_token })` |
| Insert / update / delete rows directly | nobody | no client privileges |

Permission checks use `has_community_permission()`, never role names.

## Redemption

`redeem_invitation()` is a single SECURITY DEFINER function, so the whole
redemption is one transaction:

1. Require an authenticated, active account (`42501`).
2. Hash the token and **lock the invitation row** (`SELECT ... FOR UPDATE`).
   Concurrent redemptions of the same invitation queue here, and each re-reads
   the latest `use_count` and status after the previous one commits.
3. Validate, in order:

   | Check | Error |
   |---|---|
   | token exists | `P0002` invalid invitation |
   | not revoked | `22023` revoked |
   | not expired (status or `expires_at`) | `22023` expired |
   | `use_count < max_uses` | `22023` maximum number of uses |
   | the creator **still** holds `members.invite` in an **active** community (and still has an account) | `22023` no longer valid |

4. Membership:
   - none: create it (`pending`, then admitted to `active`, so the Stage 3
     lifecycle trigger assigns the community's default **Member** role exactly as
     for an approved application);
   - `pending`, `rejected` or `left`: re-activate it (same default role);
   - `active`: refused, `23505` already a member (no use consumed);
   - `suspended`: refused, `42501`. An invitation never lifts a suspension.
5. Record the redemption, increment `use_count`, and mark the invitation
   `expired` when the last use is consumed.
6. Audit `invitation.redeemed`.

**Race safety:** the row lock makes the check-and-increment atomic, and the
`use_count <= max_uses` CHECK constraint is a second line of defence. Tests:
20 parallel API redemptions of a 3-use invitation yield exactly 3 members and
`use_count = 3`; `scripts/db/invitation-race.sh` proves that a second
redemption waits for the first and is then refused cleanly, and that 60
simultaneous redemptions of a 10-use invitation produce exactly 10 memberships.

```ts
// Admin: create a 7-day, 25-use invitation and share the token once
const { data: [invite] } = await supabase.rpc('create_invitation', {
  p_community_id: communityId, p_expires_in: '7 days', p_max_uses: 25,
});
share(`communione://join?token=${invite.token}`);

// Invitee (signed in): join
const { data: [joined], error } = await supabase.rpc('redeem_invitation', { p_token: token });
// joined: { community_id, membership_id, membership_status: 'active' }
```

## Expiry and housekeeping

Redemption checks `expires_at` itself, so expiry is exact without any job.
`public.expire_invitations()` (service role only) marks time-expired rows
`expired` so listings stay tidy; schedule it with pg_cron or an Edge Function.
`list_invitations()` also returns an `effective_status` that accounts for time.

## Audit

`invitation.created` (expires_at, max_uses), `invitation.revoked` (use_count,
previous_status), `invitation.redeemed` (membership_id, user_id). See
[`audit-logs.md`](audit-logs.md).

## Multi-tenancy

An invitation belongs to exactly one community. Administrators of community B
cannot create, list, see or revoke community A's invitations (revoking returns
"not found"), and redemption only ever creates a membership in the invitation's
own community. Covered by `020_invitations`, `022_security_sweep` and the
integration tests.

## Known limitations

- **Link invitations only.** There are no person-targeted invitations (by email
  or phone) yet, so there is no `community_invitation` notification.
- **No join requests** without an invitation.
- **No rate limit on invitation creation** beyond `members.invite`.
- **Default role only.** An invitation always grants the default Member role;
  higher roles are assigned afterwards by a role manager.

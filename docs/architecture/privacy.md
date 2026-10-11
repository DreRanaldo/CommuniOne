# Privacy: Phone Numbers and Personal Data (Pre-Stage 12)

- **Migration:** `supabase/migrations/20261011001900_phone_privacy.sql`
- **Tests:**
  - `supabase/tests/database/021_phone_privacy.test.sql` (pgTAP, 17)
  - `supabase/tests/database/007_profiles.test.sql` (phone format)
  - `tests/integration/phone-privacy.test.mjs` (real Data API, including embeds)

## Phone number policy

**Phone numbers are private by default and visible only to their owner.**

| Who | Read | Write |
|---|---|---|
| The user themselves (live session) | ✓ | ✓ (active account) |
| Other members of a shared community | ✗ | ✗ |
| Community Moderators, Admins and Owners | ✗ | ✗ |
| Members of other communities, signed-out clients | ✗ | ✗ |
| Platform admins (through the Data API) | ✗ | ✗ |
| Trusted backend code (service role) | ✓ | ✓ |

### Do administrators need phone numbers?

No current feature needs them. Community administrators contact members
through in-app notifications, announcements and alerts, none of which require a
phone number. Following data minimisation, **no** `members.view_phone`
permission was created and no role can read phone numbers.

If a future feature genuinely needs it (for example emergency call trees), add
it deliberately:

1. Add a `members.view_phone` permission in a migration (not granted to any
   default role automatically; decide per role).
2. Add a SELECT policy on `profile_private` that requires the target to have an
   **active** membership in a community where the caller holds
   `members.view_phone` (a private SECURITY DEFINER helper, like
   `private.can_view_profile`), and consider letting members opt out.
3. Audit each read through a function rather than direct table access.
4. Add tests for every row in the table above.

## How it is enforced

Profiles are readable by co-members (Stage 1/3 rules), so hiding a column would
be fragile: column revokes break `select *` and are easy to undo by accident.
Instead, the phone number was **moved out of `profiles`** into its own table:

```
profiles          (id, names, avatar_url, bio, status, ...)   co-members may read
profile_private   (user_id PK → profiles, phone, ...)          owner only
```

- `profiles.phone` was dropped after its values were copied; nothing was lost.
- RLS on `profile_private`: every policy compares `user_id` with the validated
  session user (`private.current_session_user_id()` for reads,
  `private.current_active_user_id()` for writes). There is no other policy.
- Column grants: clients can write only `phone`; `user_id` defaults to the
  caller and is immutable (trigger), so nobody can create or move a row for
  someone else.
- Format check `^\+?[0-9 ().-]{5,32}$`; values are trimmed, blanks become NULL.
- Because the restriction is on the **table**, the number cannot leak through
  member lists, `profiles` embeds such as
  `profiles?select=*,profile_private(phone)`, `my_communities()`, joins or
  any SECURITY INVOKER function. No SECURITY DEFINER function reads it.
- The phone number is deleted with the account (CASCADE) and never written to
  the audit log.

```ts
// Read / set / clear my own phone number
await supabase.from('profile_private').select('phone').maybeSingle();
await supabase.from('profile_private').upsert({ phone: '+44 20 7946 0000' });
await supabase.from('profile_private').update({ phone: null }).eq('user_id', myId);
```

`upsert` works because the primary key defaults to the caller; RLS rejects any
other `user_id`.

## Other personal data

| Data | Who can see it |
|---|---|
| Email address | Only the user (Supabase Auth). Never copied into public tables. |
| Names, avatar, bio | The user, platform admins, and members of a community where the user has a visible membership |
| Memberships | See `authorization.md` (status-based visibility) |
| Notifications | The recipient only |
| Audit logs | Pseudonymous ids only; `audit.view` holders in that community |

## Known limitations

- No per-field visibility settings (e.g. "show my phone to my building").
- Platform admins have no UI or API to read phone numbers; support access needs
  the service role, which must be used only by audited backend code.

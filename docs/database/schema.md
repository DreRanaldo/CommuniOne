# CommuniOne Database Schema (Stages 1–2)

Stage 1 set up the multi-tenant foundation: identity, communities, memberships,
roles and permissions. Stage 2 added session-validated identity, account status
enforcement, profile behaviour and platform administrators (see
[`docs/architecture/authentication.md`](../architecture/authentication.md)).
No application features (posts, events and so on) exist yet.

- **Platform:** PostgreSQL 15+ on Supabase (Auth, RLS, Data API).
- **Source of truth:** `supabase/migrations/*.sql`. The database can be rebuilt
  from empty by applying the migrations in order.
- **Tests:** `supabase/tests/database/*.test.sql` (pgTAP) and
  `tests/integration/*.test.mjs` (end to end against local Supabase).

## Running and verifying

With the Supabase CLI (Docker):

```bash
npm install
npm run db:start      # supabase start (only the services CommuniOne uses)
npm run db:reset      # applies all migrations to an empty database, then seed.sql
npm test              # pgTAP suite + end-to-end auth suite
```

With plain PostgreSQL 15+ and pgTAP (no Docker), for example in CI:

```bash
# libpq env vars select the server: PGHOST, PGPORT, PGUSER, PGPASSWORD
scripts/db/test.sh
```

`scripts/db/test.sh` drops and recreates a throwaway database
(`communione_test`) and applies `scripts/db/supabase_shim.sql`. The shim is a
minimal stand-in for Supabase's `auth` schema and API roles, and must never be
applied to a real Supabase project. The script then applies every migration and
runs `pg_prove`.

## Migrations

| # | File | Purpose |
|---|------|---------|
| 1 | `20261011000100_foundation.sql` | `private` schema, `set_updated_at()` trigger function |
| 2 | `20261011000200_profiles.sql` | `profiles`, auto-create a profile on sign-up, backfill |
| 3 | `20261011000300_tenancy_tables.sql` | communities, memberships, permissions, roles, membership_roles, role_permissions, role templates, constraints, indexes |
| 4 | `20261011000400_seed_permissions_and_role_templates.sql` | The 31 permissions, 4 default role templates and their grants |
| 5 | `20261011000500_authorization.sql` | `has_community_permission()`, private helpers, membership-transition trigger |
| 6 | `20261011000600_row_level_security.sql` | GRANTs, RLS enablement and every policy |
| 7 | `20261011000700_create_community.sql` | Atomic `create_community()` RPC |
| 8 | `20261011000800_session_validated_identity.sql` | Stage 2: `current_session_user_id()` / `current_active_user_id()`; Stage 1 functions and policies switched to the validated identity |
| 9 | `20261011000900_profiles_and_platform_admins.sql` | Stage 2: `platform_admins`, `admin_set_account_status()`, profile normalisation, https-only avatars, hardened sign-up trigger, profile policies |

## Entity relationships

```
auth.users ─┬─1:1── profiles
            ├─1:1── platform_admins (optional)
            ├─1:N── memberships ──N:1── communities ──1:N── roles
            └─1:N── communities.created_by                    │
                                                              │
memberships ──1:N── membership_roles ──N:1── roles ──1:N── role_permissions ──N:1── permissions

role_templates ──1:N── role_template_permissions ──N:1── permissions
```

## Tables

### `profiles`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | FK → `auth.users.id` **ON DELETE CASCADE** |
| first_name, last_name, display_name | text | ≤ 100 chars |
| avatar_url | text | ≤ 2048 chars, must start with `https://` (`NOT VALID` constraint: enforced for all new writes) |
| phone | text | `^\+?[0-9 ().-]{5,32}$` |
| bio | text | ≤ 1000 chars |
| status | text NOT NULL | `active` \| `suspended` \| `deactivated`, default `active`. Only changed through `admin_set_account_status()`. Anything other than `active` removes all access immediately. |
| created_at, updated_at | timestamptz NOT NULL | `updated_at` is maintained by a trigger |

- This table holds no credentials. Email, password and tokens stay in `auth.users`.
- The trigger `on_auth_user_created` on `auth.users` creates the profile, filling it
  from sign-up metadata (`first_name`, `last_name`, `display_name`/`full_name`/`name`,
  `avatar_url`). Values are trimmed and truncated, and only `https://` avatars are kept, so bad
  metadata can never block sign-up. Later metadata changes never overwrite the profile.
- The `profiles_normalize` trigger trims every text field and turns blanks into NULL.

### `platform_admins`
| Column | Type | Notes |
|---|---|---|
| user_id | uuid PK | FK → `auth.users.id` **ON DELETE CASCADE** |
| granted_by | uuid | FK → `auth.users.id` **ON DELETE SET NULL** |
| created_at | timestamptz NOT NULL | |

Platform-level administrators, the only way to edit another user's profile or
account status. RLS is enabled and there are no client grants or policies, so it
can only be managed server-side (service role or SQL).

### `communities`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| name | text NOT NULL | 1–120 chars |
| slug | text NOT NULL **UNIQUE** | 3–63 chars, `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase, so uniqueness is case-insensitive) |
| description | text | ≤ 2000 chars |
| community_type | text NOT NULL | `residential` \| `church` \| `school` \| `club` \| `association` \| `organization` \| `other` |
| logo_url, cover_image_url | text | ≤ 2048 chars |
| status | text NOT NULL | `active` \| `suspended` \| `archived`. Platform-controlled; clients cannot write it. |
| timezone | text NOT NULL | default `UTC`; a trigger checks it against `pg_timezone_names` |
| settings | jsonb NOT NULL | default `{}`; must be a JSON object |
| created_by | uuid | FK → `auth.users.id` **ON DELETE SET NULL** |
| created_at, updated_at | timestamptz NOT NULL | |

### `memberships`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **ON DELETE RESTRICT** |
| user_id | uuid NOT NULL | FK → `auth.users.id` **ON DELETE CASCADE** |
| status | text NOT NULL | `pending` \| `active` \| `suspended` \| `rejected` \| `left`, default `pending` |
| joined_at | timestamptz | Set the first time the status becomes `active` |
| created_at, updated_at | timestamptz NOT NULL | |

- `UNIQUE (community_id, user_id)` allows at most one membership per user per community.
- `UNIQUE (id, community_id)` is the target of the composite FK from `membership_roles`.
- `community_id` and `user_id` can never change once set (enforced by trigger).

### `permissions`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| key | text NOT NULL **UNIQUE** | `module.action`, e.g. `posts.create` |
| description | text NOT NULL | |
| module | text NOT NULL | CHECK: must equal the prefix of `key` |
| created_at | timestamptz NOT NULL | |

This is a global catalog. Migration 4 seeds it with exactly these 31 keys:
`community.view`, `community.update`, `members.view`, `members.invite`,
`members.approve`, `members.suspend`, `members.remove`, `roles.view`,
`roles.manage`, `posts.view`, `posts.create`, `posts.edit_own`, `posts.delete_own`,
`posts.moderate`, `comments.create`, `comments.edit_own`, `comments.delete_own`,
`comments.moderate`, `announcements.view`, `announcements.create`,
`announcements.manage`, `alerts.view`, `alerts.create`, `alerts.manage`,
`events.view`, `events.create`, `events.manage`, `documents.view`,
`documents.upload`, `documents.manage`, `audit.view`.

### `roles`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **ON DELETE RESTRICT** |
| name | text NOT NULL | 1–60 chars; **unique per community, case-insensitive** (`lower(name)`) |
| description | text | ≤ 500 chars |
| is_system_role | boolean NOT NULL | `true` for roles copied from templates. Clients cannot create, edit or delete system roles, or change their permissions. |
| created_at, updated_at | timestamptz NOT NULL | |

`UNIQUE (id, community_id)` is the target of the composite FK from `membership_roles`.

### `membership_roles`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | Filled by trigger from the membership (see below) |
| membership_id | uuid NOT NULL | FK `(membership_id, community_id)` → `memberships(id, community_id)` **ON DELETE CASCADE** |
| role_id | uuid NOT NULL | FK `(role_id, community_id)` → `roles(id, community_id)` **ON DELETE RESTRICT** |
| created_at | timestamptz NOT NULL | |

- `UNIQUE (membership_id, role_id)` prevents assigning the same role twice.
- **Change from the original spec:** I added `community_id`. With the two
  composite foreign keys, a constraint (not just a policy) makes it impossible to
  attach a role from Community B to a membership in Community A, even for
  service-role code. Clients only send `membership_id` and `role_id`.

### `role_permissions`
| Column | Type | Notes |
|---|---|---|
| role_id | uuid | FK → `roles.id` **ON DELETE CASCADE** |
| permission_id | uuid | FK → `permissions.id` **ON DELETE RESTRICT** |

`PRIMARY KEY (role_id, permission_id)`

### `role_templates` / `role_template_permissions`
These hold the default role definitions. `create_community()` copies them into
each new community as system roles. Exactly one template has
`assign_to_creator = true` (enforced by a partial unique index), and that template
is granted to the creator. Editing a template changes only communities created
afterwards. Existing communities are not touched.

## Default roles and permissions

Each tier is a strict superset of the tier below it (a test checks this).

| Permission | Member | Moderator | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| community.view | ✓ | ✓ | ✓ | ✓ |
| community.update | | | ✓ | ✓ |
| members.view | ✓ | ✓ | ✓ | ✓ |
| members.invite | | | ✓ | ✓ |
| members.approve | | | ✓ | ✓ |
| members.suspend | | ✓ | ✓ | ✓ |
| members.remove | | | ✓ | ✓ |
| roles.view | ✓ | ✓ | ✓ | ✓ |
| roles.manage | | | | ✓ |
| posts.view / create / edit_own / delete_own | ✓ | ✓ | ✓ | ✓ |
| posts.moderate | | ✓ | ✓ | ✓ |
| comments.create / edit_own / delete_own | ✓ | ✓ | ✓ | ✓ |
| comments.moderate | | ✓ | ✓ | ✓ |
| announcements.view | ✓ | ✓ | ✓ | ✓ |
| announcements.create / manage | | | ✓ | ✓ |
| alerts.view | ✓ | ✓ | ✓ | ✓ |
| alerts.create / manage | | | ✓ | ✓ |
| events.view | ✓ | ✓ | ✓ | ✓ |
| events.create / manage | | | ✓ | ✓ |
| documents.view | ✓ | ✓ | ✓ | ✓ |
| documents.upload / manage | | | ✓ | ✓ |
| audit.view | | | ✓ | ✓ |
| **Total** | **14** | **17** | **30** | **31** |

- **Owner:** full administration. Only Owners hold `roles.manage`, so only they
  (or a custom role an Owner creates) can change the permission structure.
- **Admin:** runs members and content day to day. Everything except `roles.manage`.
- **Moderator:** Member permissions plus `members.suspend`, `posts.moderate` and
  `comments.moderate`.
- **Member:** normal participation, plus viewing other members and roles.

## ON DELETE decisions

| Relationship | Rule | Why |
|---|---|---|
| profiles.id → auth.users | CASCADE | A profile only exists because of its account. Account deletion (right to erasure) must remove it. |
| communities.created_by → auth.users | SET NULL | A community outlives its creator's account. |
| memberships.community_id → communities | RESTRICT | Communities are archived, not hard-deleted. RESTRICT stops one mistaken DELETE from wiping a tenant's membership history. |
| memberships.user_id → auth.users | CASCADE | Account deletion must not be blocked. The user's memberships go with the account. |
| roles.community_id → communities | RESTRICT | Same reason as memberships. |
| membership_roles → memberships | CASCADE | An assignment means nothing without its membership. |
| membership_roles → roles | RESTRICT | Deleting a role that is still assigned would silently change people's access, so unassigning must be explicit. |
| role_permissions → roles | CASCADE | Grants belong to the role. |
| role_permissions → permissions | RESTRICT | Retiring a permission that is in use must be a deliberate migration. |
| role_template_permissions → role_templates / permissions | CASCADE / RESTRICT | Same reasoning as above. |

To hard-delete a community, an operator using the service role must explicitly
delete its `membership_roles`, `memberships` and `roles` first.

## Indexes

| Access pattern | Served by |
|---|---|
| communities.slug | `communities_slug_key` (unique) |
| memberships.community_id | `memberships_community_user_key` (leading column) |
| memberships.user_id | `memberships_user_id_idx` |
| memberships.community_id + status | `memberships_community_status_idx` |
| roles.community_id | `roles_community_name_key` (leading column) |
| membership_roles.membership_id | `membership_roles_membership_role_key` (leading column) |
| membership_roles.role_id | `membership_roles_role_id_idx` |
| role_permissions.role_id | `role_permissions_pkey` (leading column) |
| role_permissions.permission_id | `role_permissions_permission_id_idx` (FK checks on permission delete) |

Where a composite unique index already starts with the column in question, I did
not add a separate single-column index, because it would be redundant. The test
`001_schema.test.sql` checks that every required pattern has an index starting
with those columns.

## Authorization and RLS

See [`docs/architecture/authorization.md`](../architecture/authorization.md) for
the full model. In short:

- RLS is enabled on **every** table in `public`, and a test checks this.
- Supabase grants ALL on new tables to `anon` and `authenticated` by default.
  Migration 6 revokes everything first, then grants back only what is needed,
  down to individual columns.
- `anon` has no access to any Stage 1 table or function.
- Every tenant-scoped policy goes through `public.has_community_permission()`
  or a `private.*` helper. No policy checks a role name.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | self (live session, any account status), platform admin, or the target has a live membership in a community where the caller has `members.view` | ✗ (sign-up trigger) | self (active account) or platform admin; columns: names, avatar, phone, bio | ✗ (account deletion cascades) |
| platform_admins | ✗ | ✗ | ✗ | ✗ (server-side only) |
| communities | `community.view` | ✗ (only via `create_community()`) | `community.update`; columns: name, description, type, logo, cover, timezone, settings | ✗ |
| memberships | own row, or `members.view` | ✗ (Stage 2 invitations) | `status` only; transitions are checked by trigger (see below) | `members.remove`, not self, and the caller covers the target |
| roles | `roles.view` | `roles.manage`, custom roles only | `roles.manage`, custom roles only; name and description | `roles.manage`, custom roles, and the caller covers the role |
| membership_roles | own, or `members.view` | `roles.manage`, not own membership, the caller covers the target membership **and** the role | ✗ | same as insert |
| role_permissions | `roles.view` in the role's community | `roles.manage`, custom role, and the caller holds that permission | ✗ | same as insert |
| permissions, role_templates, role_template_permissions | any authenticated user | ✗ | ✗ | ✗ |

**"Covers"** means every permission the target membership or role holds is
also held by the caller in that community. This is the anti-escalation rule.

### Membership status transitions (`private.enforce_membership_update`)

| From → To | Who |
|---|---|
| pending / active / suspended → left | the member themselves (blocked if they are the last active member with `roles.manage`) |
| pending / rejected / left → active | `members.approve` and covers the target |
| pending → rejected | `members.approve` and covers the target |
| active → suspended, suspended → active | `members.suspend` and covers the target |
| anything else | rejected (`22023`) |

The trigger applies only to client roles (`authenticated`, `anon`). Trusted
server code (`service_role`, migrations, SECURITY DEFINER functions) is not
restricted by it.

## Key security decisions

1. **Authorization resolves to permission keys, never role names.** Roles are
   labels that communities can rename or replace.
2. **SECURITY DEFINER only where needed:** `has_community_permission()`, the
   `private.*` lookup helpers, `create_community()` and the sign-up trigger.
   Each pins `search_path = ''`, takes the actor from `private.current_active_user_id()` (Stage 2) and never from
   a parameter, and runs no dynamic SQL. A test checks the `search_path` pinning.
3. **Helpers live in the `private` schema,** which the Supabase Data API does not
   expose, so clients cannot call them as RPCs.
4. **Clients cannot insert memberships in Stage 1.** Otherwise a community admin
   could "add" any user by UUID and then read that user's profile. Memberships
   will come from consent-based flows (invitations and join requests) in Stage 2.
5. **Tenant consistency is enforced by constraints:** the composite FKs on
   `membership_roles`.
6. **Permission and template seed data lives in migrations,** not `seed.sql`,
   because production needs it too.
7. **A community cannot be orphaned by its last role manager leaving.**
8. **Identity is validated server-side on every request (Stage 2).** A token
   only counts if its `auth.sessions` row still exists and the account is
   `active`, so sign-out, session revocation and account suspension take effect
   immediately instead of when the token expires.
9. **Profiles are global, so community permissions never grant profile edits
   (Stage 2).** Only the user, or a platform admin, can edit a profile.

# CommuniOne Database Schema (Stages 1–6)

Stage 1 set up the multi-tenant foundation: identity, communities, memberships,
roles and permissions. Stage 2 added session-validated identity, account status
enforcement, profile behaviour and platform administrators (see
[`docs/architecture/authentication.md`](../architecture/authentication.md)).
Stage 3 completed the community and membership API (see
[`docs/api/communities-and-memberships.md`](../api/communities-and-memberships.md)).
Stage 5 added posts, comments and reactions (see
[`docs/features/posts.md`](../features/posts.md)). Stage 6 added announcements (see
[`docs/features/announcements.md`](../features/announcements.md)). Stage 4
(invitations and the audit log) has not been built.

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
| 10 | `20261011001000_community_membership_api.sql` | Stage 3: memberships → profiles FK (member-profile embedding), status-based membership visibility, `my_communities()`, `my_community_permissions()`, default role for new members and the role lifecycle on status changes, community creation limit, `settings` size cap |
| 11 | `20261011001100_posts_comments_reactions.sql` | Stage 5: posts, comments, reactions, their RLS, lifecycle triggers, `list_community_posts()`, `list_post_comments()`, `get_reaction_summary()` |
| 12 | `20261011001200_announcements.sql` | Stage 6: announcements, their RLS, lifecycle trigger, `list_current_announcements()`, `list_announcement_history()` |

## Entity relationships

```
auth.users ─┬─1:1── profiles
            ├─1:1── platform_admins (optional)
            ├─1:N── memberships ──N:1── communities ──1:N── roles
            └─1:N── communities.created_by                    │
                                                              │
memberships ──1:N── membership_roles ──N:1── roles ──1:N── role_permissions ──N:1── permissions

role_templates ──1:N── role_template_permissions ──N:1── permissions

communities ──1:N── posts ──1:N── comments ──(parent_comment_id, same post)──┐
                      │             │  ◄──────────────────────────────────────┘
                      └── reactions ┘   (exactly one of post_id / comment_id)
profiles ──1:N── posts / comments / reactions (author / user)
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
| user_id | uuid NOT NULL | FK → `auth.users.id` **ON DELETE CASCADE**; also FK → `profiles.id` **ON DELETE CASCADE** (Stage 3, so the Data API can embed member profiles) |
| status | text NOT NULL | `pending` \| `active` \| `suspended` \| `rejected` \| `left`, default `pending` |
| joined_at | timestamptz | Set the first time the status becomes `active` |
| created_at, updated_at | timestamptz NOT NULL | |

- `UNIQUE (community_id, user_id)` allows at most one membership per user per community.
- `UNIQUE (id, community_id)` is the target of the composite FK from `membership_roles`.
- `community_id` and `user_id` can never change once set (enforced by trigger).
- Role lifecycle (Stage 3, trigger `memberships_role_lifecycle`):
  - → `active` with no roles assigns the community's default role for new members;
  - → `left` / `rejected` removes all role assignments;
  - suspension keeps them.

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
| is_default_for_new_members | boolean NOT NULL | Stage 3. The role given to newly admitted members (at most one per community, by partial unique index). Copied from the template and not client-writable. |
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
is granted to the creator. Exactly one template has `assign_to_new_members = true`
(Member; Stage 3), and its copy becomes each community's default role for new
members. Editing a template changes only communities created
afterwards. Existing communities are not touched.

### `posts` (Stage 5)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT** |
| author_user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE**; defaults to the validated session user; not client-writable |
| body | text NOT NULL | 1–10 000 chars (trimmed) |
| status | text NOT NULL | `published` \| `hidden` \| `deleted`, default `published` |
| visibility | text NOT NULL | `members` (only value today; new values need new RLS) |
| edited_at | timestamptz | Set when the body changes |
| moderated_by_user_id | uuid | FK → `profiles.id` **SET NULL**; stamped by trigger |
| moderated_at | timestamptz | Stamped by trigger |
| moderation_reason | text | ≤ 500 chars; moderators only |
| created_at, updated_at | timestamptz NOT NULL | |

`UNIQUE (id, community_id)` is the target of the composite FKs from comments and reactions.

### `comments` (Stage 5)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | Derived from the post by trigger |
| post_id | uuid NOT NULL | FK `(post_id, community_id)` → `posts(id, community_id)` **CASCADE** |
| author_user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE**; session default |
| parent_comment_id | uuid | FK `(parent_comment_id, post_id)` → `comments(id, post_id)` **SET NULL (parent_comment_id)**: same post only; replies become top-level if the parent is physically removed |
| depth | smallint NOT NULL | 0–9, derived from the parent |
| body | text NOT NULL | 1–5 000 chars |
| status, edited_at, moderated_by_user_id, moderated_at, moderation_reason, created_at, updated_at | | As for posts |

`UNIQUE (id, post_id)` and `UNIQUE (id, community_id)` exist; `CHECK (parent_comment_id <> id)`.

### `reactions` (Stage 5)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | Derived from the target by trigger; immutable |
| user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE**; session default; not client-writable |
| post_id | uuid | FK `(post_id, community_id)` → `posts` **CASCADE** |
| comment_id | uuid | FK `(comment_id, community_id)` → `comments` **CASCADE** |
| reaction_type | text NOT NULL | `like` \| `love` \| `celebrate` \| `support` \| `laugh` \| `sad` |
| created_at, updated_at | timestamptz NOT NULL | |

- `CHECK (num_nonnulls(post_id, comment_id) = 1)` means each reaction has exactly one target.
- Partial unique indexes allow one reaction per user per post and per comment.

### `announcements` (Stage 6)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT**; immutable |
| author_user_id | uuid | FK → `profiles.id` **SET NULL**; session default; not client-writable |
| title | text NOT NULL | 1–200 chars |
| body | text NOT NULL | 1–20 000 chars |
| priority | text NOT NULL | `normal` \| `important` |
| status | text NOT NULL | `draft` \| `published` \| `archived` \| `deleted`, default `draft` |
| published_at | timestamptz | Server-stamped on (re)publication |
| expires_at | timestamptz | Optional; `> published_at` |
| archived_at, edited_at | timestamptz | Server-stamped |
| updated_by_user_id | uuid | FK → `profiles.id` **SET NULL**; server-stamped |
| created_at, updated_at | timestamptz NOT NULL | |

Constraints: published and archived rows have `published_at`; `expires_at > published_at`.

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
| memberships.user_id → profiles | CASCADE | Same lifecycle as the account (the profile is deleted with it). Exists for Data API embedding. |
| roles.community_id → communities | RESTRICT | Same reason as memberships. |
| membership_roles → memberships | CASCADE | An assignment means nothing without its membership. |
| membership_roles → roles | RESTRICT | Deleting a role that is still assigned would silently change people's access, so unassigning must be explicit. |
| role_permissions → roles | CASCADE | Grants belong to the role. |
| role_permissions → permissions | RESTRICT | Retiring a permission that is in use must be a deliberate migration. |
| role_template_permissions → role_templates / permissions | CASCADE / RESTRICT | Same reasoning as above. |
| posts.community_id → communities | RESTRICT | Same as other community children |
| posts / comments / reactions author or user → profiles | CASCADE | Account deletion (right to erasure) removes the person's content |
| comments.post_id → posts, reactions → posts / comments | CASCADE | Children of physically removed content go with it. Normal deletion is soft (status). |
| comments.parent_comment_id → comments | SET NULL (parent only) | Other users' replies survive as top-level comments |
| announcements.community_id → communities | RESTRICT | Same as other community children |
| announcements.author_user_id / updated_by_user_id → profiles | SET NULL | Official communications outlive their author's account |
| moderated_by_user_id → profiles | SET NULL | Moderation records outlive the moderator's account |

To hard-delete a community, an operator using the service role must explicitly
delete its `membership_roles`, `memberships` and `roles` first.

## Indexes

| Access pattern | Served by |
|---|---|
| communities.slug | `communities_slug_key` (unique) |
| memberships.community_id | `memberships_community_user_key` (leading column) |
| memberships.user_id | `memberships_user_id_idx` |
| memberships.community_id + status | `memberships_community_status_idx` |
| posts by community, newest first | `posts_community_feed_idx (community_id, created_at desc, id desc)` |
| comments by post, oldest first | `comments_post_thread_idx (post_id, created_at, id)` |
| comments by parent | `comments_parent_thread_idx (parent_comment_id, created_at, id)` (partial) |
| reactions by post / comment (+ one per user) | `reactions_one_per_user_post (post_id, user_id)`, `reactions_one_per_user_comment (comment_id, user_id)` (partial unique) |
| reactions by user | `reactions_user_idx` |
| posts / comments by author | `posts_author_idx`, `comments_author_idx` |
| announcements by community, status, publication date | `announcements_community_status_published_idx (community_id, status, published_at desc, id desc)` |
| announcement expiry | `announcements_community_expiry_idx (community_id, expires_at) WHERE status = 'published'` |
| communities.created_by + created_at | `communities_created_by_created_at_idx` (Stage 3: creation limit; FK `SET NULL` on account deletion) |
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
| profiles | self (live session, any account status), platform admin, or the target has a membership the caller may see (see the memberships row) | ✗ (sign-up trigger) | self (active account) or platform admin; columns: names, avatar, phone, bio | ✗ (account deletion cascades) |
| platform_admins | ✗ | ✗ | ✗ | ✗ (server-side only) |
| communities | `community.view` | ✗ (only via `create_community()`) | `community.update`; columns: name, description, type, logo, cover, timezone, settings | ✗ |
| memberships | own row; `active` rows with `members.view`; other statuses with `members.approve`, `members.suspend` or `members.remove` (Stage 3) | ✗ (invitations in a later stage) | `status` only; transitions are checked by trigger (see below) | `members.remove`, not self, and the caller covers the target |
| roles | `roles.view` | `roles.manage`, custom roles only | `roles.manage`, custom roles only; name and description | `roles.manage`, custom roles, and the caller covers the role |
| membership_roles | own, or the membership is visible (as above) | `roles.manage`, not own membership, the caller covers the target membership **and** the role | ✗ | same as insert |
| role_permissions | `roles.view` in the role's community | `roles.manage`, custom role, and the caller holds that permission | ✗ | same as insert |
| permissions, role_templates, role_template_permissions | any authenticated user | ✗ | ✗ | ✗ |
| posts (Stage 5) | published: `posts.view`; hidden or deleted: `posts.moderate` or the author | `posts.create`, as yourself, always `published`; columns: community_id, body | author (`edit_own` / `delete_own`) or `posts.moderate`; columns: body, status, moderation_reason; trigger enforces the lifecycle | ✗ (soft delete) |
| comments (Stage 5) | post visible, and published, or `comments.moderate`, or the author | `comments.create` on a published visible post (published parent on the same post); columns: post_id, parent_comment_id, body | as posts, with `comments.*` | ✗ |
| announcements (Stage 6) | published or archived: `announcements.view` / `manage`; draft or deleted: `announcements.manage`, or the author holding `announcements.create` | `announcements.create`, as yourself, draft or published; columns: community_id, title, body, priority, status, expires_at | `announcements.manage`, or the author holding `announcements.create`; columns: title, body, priority, status, expires_at; trigger enforces the lifecycle | ✗ (soft delete) |
| reactions (Stage 5) | target visible, or your own | your own, on published visible content, with `posts.view`; columns: post_id or comment_id, reaction_type | own; reaction_type only | own |

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

### Client RPCs (Stages 3, 5 and 6)

| Function | Returns | Notes |
|---|---|---|
| `public.create_community(...)` | the new community | Atomic. At most 10 per user per rolling 24 hours (`53400`). |
| `public.my_communities()` | the caller's pending, active and suspended memberships, with community basics and role names | SECURITY DEFINER, so pending and suspended members can see their status even though they cannot read `communities` |
| `public.my_community_permissions(community_id)` | the caller's permission keys | For UI gating only |
| `public.has_community_permission(community_id, key)` | boolean | Stage 1 |
| `public.list_community_posts(...)` / `public.list_post_comments(...)` | cursor-paginated pages | Stage 5, SECURITY INVOKER |
| `public.list_current_announcements(...)` / `public.list_announcement_history(...)` | cursor-paginated pages | Stage 6, SECURITY INVOKER |
| `public.get_reaction_summary(post_ids, comment_ids)` | counts per type | Stage 5, SECURITY INVOKER, at most 100 ids each |
| `public.admin_set_account_status(user_id, status)` | profile | Stage 2, platform admins only |

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

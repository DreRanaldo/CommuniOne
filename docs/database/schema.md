# CommuniOne Database Schema (Stages 1–11 and Pre-Stage 12)

Stage 1 set up the multi-tenant foundation: identity, communities, memberships,
roles and permissions. Stage 2 added session-validated identity, account status
enforcement, profile behaviour and platform administrators (see
[`docs/architecture/authentication.md`](../architecture/authentication.md)).
Stage 3 completed the community and membership API (see
[`docs/api/communities-and-memberships.md`](../api/communities-and-memberships.md)).
Stage 5 added posts, comments and reactions (see
[`docs/features/posts.md`](../features/posts.md)). Stage 6 added announcements (see
[`docs/features/announcements.md`](../features/announcements.md)). Stage 7 added
alerts and the alert event outbox (see
[`docs/features/alerts.md`](../features/alerts.md)). Stage 8 added events and
RSVPs (see [`docs/features/events.md`](../features/events.md)). Stage 9 added
in-app notifications and the notification service (see
[`docs/features/notifications.md`](../features/notifications.md)). Stage 10
added documents and file storage (see
[`docs/features/documents.md`](../features/documents.md)). Stage 11 added the
audit log (see [`docs/features/audit-logs.md`](../features/audit-logs.md)).
The Pre-Stage 12 hardening milestone added account deletion (see
[`docs/architecture/account-deletion.md`](../architecture/account-deletion.md)),
private phone numbers (see [`docs/architecture/privacy.md`](../architecture/privacy.md))
and invitations, which complete Stage 4 (see
[`docs/features/invitations.md`](../features/invitations.md)).

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
scripts/db/invitation-race.sh # concurrency: invitation row lock and max_uses under a burst
scripts/db/rsvp-stress.sh     # concurrency: event capacity under pgbench load
```

CI runs all of these on every pull request (see
[`docs/development/ci.md`](../development/ci.md)).

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
| 13 | `20261011001300_alerts.sql` | Stage 7: alerts, alert_events outbox, RLS, severity and lifecycle trigger, expiry sweep, active/history list functions |
| 14 | `20261011001400_events.sql` | Stage 8: events, event_rsvps, RLS, lifecycle trigger, lock-based capacity and FIFO waitlist, RSVP / attendance / list functions |
| 15 | `20261011001500_notifications.sql` | Stage 9: notifications, notification_types, RLS, notification service, producers for announcements / alerts / events / waitlist / comments / membership, client RPCs |
| 16 | `20261011001600_documents.sql` | Stage 10: documents, document_folders, upload settings and MIME allow-list, private `documents` bucket, metadata RLS, storage.objects policies, two-phase upload RPCs, listing, purge listing |
| 17 | `20261011001700_audit_logs.sql` | Stage 11: audit_logs, audit_actions, append-only protection, redaction, audit service, producers on all audited tables, read RPC, retention purge |
| 18 | `20261011001800_account_deletion.sql` | Pre-Stage 12: creator columns nullable + `ON DELETE SET NULL` (posts, comments, alerts, events, documents), erasure-aware write triggers, sole-role-manager deletion guard, `delete_my_account()` |
| 19 | `20261011001900_phone_privacy.sql` | Pre-Stage 12: `profile_private` (owner-only phone number); `profiles.phone` migrated and dropped |
| 20 | `20261011002000_invitations.sql` | Pre-Stage 12 / Stage 4: invitations, invitation_redemptions, hashed tokens, create / revoke / redeem / list RPCs, audit actions |

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
| bio | text | ≤ 1000 chars |
| status | text NOT NULL | `active` \| `suspended` \| `deactivated`, default `active`. Only changed through `admin_set_account_status()`. Anything other than `active` removes all access immediately. |
| created_at, updated_at | timestamptz NOT NULL | `updated_at` is maintained by a trigger |

- This table holds no credentials. Email, password and tokens stay in `auth.users`.
- It holds no phone number either (Pre-Stage 12): co-members can read profiles,
  so private contact details live in `profile_private`.
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
| author_user_id | uuid | FK → `profiles.id` **SET NULL** (NULL = "Deleted User"); defaults to the validated session user; not client-writable |
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
| author_user_id | uuid | FK → `profiles.id` **SET NULL** (NULL = "Deleted User"); session default |
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

### `alerts` (Stage 7)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT**; immutable |
| created_by | uuid | FK → `profiles.id` **SET NULL** (NULL = "Deleted User"; the audit log keeps accountability); session default; not client-writable |
| title / body | text NOT NULL | 1–160 / 1–5 000 chars |
| severity | text NOT NULL | `info` \| `warning` \| `urgent` \| `emergency` |
| severity_rank / is_emergency | generated | 1–4 / `severity = 'emergency'` |
| status | text NOT NULL | `draft` \| `published` \| `expired` \| `cancelled` \| `archived` |
| published_at, published_by, expired_at, cancelled_at, cancelled_by, archived_at, edited_at, updated_by_user_id | | Server-stamped; user columns FK → profiles **SET NULL** |
| expires_at | timestamptz | Optional; in the future when publishing |
| cancellation_reason | text | ≤ 500; only with cancellation |

### `alert_events` (Stage 7)
Transactional outbox and audit trail, written only by trigger:
- `alert_id` (FK → alerts **CASCADE**) and `community_id` (FK **RESTRICT**);
- `event_type`: `published` \| `updated` \| `cancelled` \| `expired`;
- `severity` at the time of the event;
- `actor_user_id` (FK → profiles **SET NULL**; NULL = system);
- `occurred_at`, and `dispatched_at` (for the future notification worker).

### `events` (Stage 8)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `UNIQUE (id, community_id)` for the RSVP composite FK |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT**; immutable |
| created_by | uuid | FK → `profiles.id` **SET NULL** (NULL = "Deleted User"); session default |
| title / description / location_text | text | 1–200 / ≤ 10 000 / ≤ 500 |
| starts_at, ends_at | timestamptz NOT NULL | `ends_at >= starts_at` |
| timezone | text NOT NULL | IANA, validated |
| capacity | integer | NULL = unlimited; 1–100 000 |
| status | text NOT NULL | `draft` \| `published` \| `cancelled` \| `completed` |
| published_at, cancelled_at, cancelled_by, cancellation_reason, completed_at, edited_at, updated_by_user_id, rsvp_changed_at | | Server-stamped (`rsvp_changed_at` is the capacity lock) |

### `event_rsvps` (Stage 8)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | Derived from the event |
| event_id | uuid NOT NULL | FK `(event_id, community_id)` → `events` **CASCADE** |
| user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE**; session default |
| status | text NOT NULL | `going` \| `maybe` \| `not_going` \| `waitlisted` (server-assigned) |
| waitlisted_at | timestamptz | Set exactly while waitlisted (CHECK) |

`UNIQUE (event_id, user_id)`.

### `notifications` (Stage 9)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE**; the recipient |
| community_id | uuid | FK → `communities.id` **CASCADE** (derived data) |
| type | text NOT NULL | FK → `notification_types.key` **RESTRICT** |
| title / body | text | 1–200 / ≤ 1 000 |
| data | jsonb NOT NULL | Object, ≤ 8 KiB, deep-link ids |
| dedupe_key | text | Unique per user (idempotency) |
| read_at, archived_at | timestamptz | Server-stamped; the only client-writable columns |
| created_at | timestamptz NOT NULL | |

### `notification_types` (Stage 9)
Catalog: `key` PK, `description`, `requires_membership`, `default_priority`.

Seeded with `announcement`, `alert`, `event_created`, `event_updated`,
`event_cancelled`, `comment`, `membership` and `system`.

### `documents` (Stage 10)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT**; immutable |
| uploaded_by | uuid | FK → `profiles.id` **SET NULL** (NULL = "Deleted User"; document and file are kept); session user; immutable |
| folder_id | uuid | FK `(folder_id, community_id)` → `document_folders` **SET NULL (folder_id)** |
| name | text NOT NULL | Sanitised display name |
| mime_type / file_extension | text NOT NULL | Allow-listed (FK → `document_mime_types`) |
| storage_path | text | **Generated** `communities/{community_id}/documents/{id}/file.{ext}`; unique |
| file_size | bigint NOT NULL | As recorded by Storage |
| visibility | text NOT NULL | `members` \| `managers` |
| status | text NOT NULL | `pending_upload` \| `active` \| `archived` \| `deleted` |
| uploaded_at, archived_at, deleted_at, file_purged_at, updated_by_user_id | | Server-stamped |

### `document_folders` (Stage 10)
- `community_id`, `parent_folder_id`;
- FK `(parent_folder_id, community_id)` for same-community nesting, **SET NULL** on parent deletion;
- `name` unique per parent; `created_by`;
- cycles are rejected.

### `document_upload_settings` / `document_mime_types` (Stage 10)
Configuration, writable only by the service role:
- the maximum file size (default 25 MiB, at most the 50 MiB bucket ceiling);
- the MIME allow-list, mapping each type to its extension.

Files are stored in the private Storage bucket `documents`, whose access is
governed by RLS policies on `storage.objects` (see `documents.md`).

### `audit_logs` (Stage 11)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid | NULL = system event; **no FK** (history outlives the community) |
| actor_user_id | uuid | Session user or NULL (system); **no FK** |
| action | text NOT NULL | FK → `audit_actions.action` **RESTRICT** |
| entity_type / entity_id | text / uuid | What was acted on |
| metadata | jsonb NOT NULL | ≤ 8 KiB; credential-like keys redacted on insert |
| created_at | timestamptz NOT NULL | `clock_timestamp()` |

Append-only: UPDATE, DELETE and TRUNCATE are rejected by triggers for every
role. Rows leave only through `purge_audit_logs()` (service role, at least
90 days).

### `audit_actions` (Stage 11)
Catalog `(action PK, entity_type, description)`.

### `profile_private` (Pre-Stage 12)
| Column | Type | Notes |
|---|---|---|
| user_id | uuid PK | FK → `profiles.id` **CASCADE**; defaults to the caller; immutable |
| phone | text | `^\+?[0-9 ().-]{5,32}$`, trimmed, blank → NULL |
| created_at, updated_at | timestamptz NOT NULL | |

Readable and writable **only by its owner**. No administrator access (see
[`privacy.md`](../architecture/privacy.md)).

### `invitations` (Pre-Stage 12 / Stage 4)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT**; immutable |
| created_by | uuid | FK → `profiles.id` **SET NULL**; a creator-less invitation cannot be redeemed |
| token_hash | text NOT NULL UNIQUE | SHA-256 hex of the token; **not selectable by clients**; immutable |
| expires_at | timestamptz NOT NULL | 1 hour – 30 days after creation; `> created_at` |
| max_uses | integer | NULL = unlimited, else 1–10 000 |
| use_count | integer NOT NULL | ≥ 0, ≤ `max_uses`, can only increase |
| status | text NOT NULL | `active` \| `expired` \| `revoked` |
| revoked_at, revoked_by | timestamptz, uuid | `revoked_by` FK → profiles **SET NULL** |
| created_at, updated_at | timestamptz NOT NULL | |

### `invitation_redemptions` (Pre-Stage 12 / Stage 4)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| invitation_id | uuid NOT NULL | FK → `invitations.id` **CASCADE** |
| community_id | uuid NOT NULL | FK → `communities.id` **RESTRICT** |
| user_id | uuid NOT NULL | FK → `profiles.id` **CASCADE** (personal record) |
| membership_id | uuid | FK → `memberships.id` **SET NULL** |
| redeemed_at | timestamptz NOT NULL | |

`UNIQUE (invitation_id, user_id)`.

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
| posts / comments author → profiles | SET NULL (Pre-Stage 12) | Community history survives account deletion, shown as "Deleted User" (see `account-deletion.md`) |
| reactions.user_id → profiles | CASCADE | Reactions are personal records |
| comments.post_id → posts, reactions → posts / comments | CASCADE | Children of physically removed content go with it. Normal deletion is soft (status). |
| comments.parent_comment_id → comments | SET NULL (parent only) | Other users' replies survive as top-level comments |
| notifications.user_id → profiles | CASCADE | A user's notifications go with their account |
| notifications.community_id → communities | CASCADE | Notifications are derived data |
| notifications.type → notification_types | RESTRICT | A type in use cannot be removed |
| documents.uploaded_by → profiles | SET NULL (Pre-Stage 12) | The document and its Storage file are kept |
| documents.community_id, document_folders.community_id → communities | RESTRICT | Same as other community children |
| documents.folder_id / document_folders.parent_folder_id | SET NULL (column only) | Deleting a folder moves its contents to the top level |
| documents.mime_type → document_mime_types | RESTRICT | Types in use cannot be removed (disable them instead) |
| events.created_by → profiles | SET NULL (Pre-Stage 12) | Events outlive their creator; `events.manage` holders keep managing them |
| events.community_id → communities | RESTRICT | Same as other community children |
| event_rsvps → events | CASCADE | RSVPs belong to their event |
| event_rsvps.user_id → profiles | CASCADE | Account deletion removes the person's RSVPs |
| alerts.created_by → profiles | SET NULL (Pre-Stage 12) | Safety records are kept; the audit log keeps the pseudonymous actor id (see `alerts.md`) |
| alerts.community_id, alert_events.community_id → communities | RESTRICT | Same as other community children |
| alert_events.alert_id → alerts | CASCADE | Events belong to their alert |
| announcements.community_id → communities | RESTRICT | Same as other community children |
| announcements.author_user_id / updated_by_user_id → profiles | SET NULL | Official communications outlive their author's account |
| moderated_by_user_id → profiles | SET NULL | Moderation records outlive the moderator's account |
| document_folders.created_by → profiles | SET NULL | Folders outlive their creator |
| profile_private.user_id → profiles | CASCADE | Private details are erased with the account |
| invitations.community_id, invitation_redemptions.community_id → communities | RESTRICT | Same as other community children |
| invitations.created_by / revoked_by → profiles | SET NULL | The invitation record is kept; a creator-less invitation stops working |
| invitation_redemptions.invitation_id → invitations | CASCADE | Usage rows belong to their invitation |
| invitation_redemptions.user_id → profiles | CASCADE | Personal record, erased with the account |
| invitation_redemptions.membership_id → memberships | SET NULL | Removing a member keeps the usage history |

Before `profiles` (and so the account) is deleted, the `profiles_guard_deletion`
trigger refuses deletion of the **only** active member able to manage roles in a
community that still has other active members (`55000`: transfer ownership first),
and archives communities in which the user is the last active member.

To hard-delete a community, an operator using the service role must explicitly
delete its `membership_roles`, `memberships` and `roles` first.

## Indexes

| Access pattern | Served by |
|---|---|
| communities.slug | `communities_slug_key` (unique) |
| memberships.community_id | `memberships_community_user_key` (leading column) |
| memberships.user_id | `memberships_user_id_idx` |
| memberships.community_id + status (+ created_at, id for the member list) | `memberships_community_status_created_idx` (Stage 12) |
| posts by community, newest first | `posts_community_feed_idx (community_id, created_at desc, id desc)` |
| comments by post, oldest first | `comments_post_thread_idx (post_id, created_at, id)` |
| comments by parent | `comments_parent_thread_idx (parent_comment_id, created_at, id)` (partial) |
| reactions by post / comment (+ one per user) | `reactions_one_per_user_post (post_id, user_id)`, `reactions_one_per_user_comment (comment_id, user_id)` (partial unique) |
| reactions by user | `reactions_user_idx` |
| posts / comments by author | `posts_author_idx`, `comments_author_idx` |
| announcements by community, status, publication date | `announcements_community_status_published_idx (community_id, status, published_at desc, id desc)` |
| announcement expiry | `announcements_community_expiry_idx (community_id, expires_at) WHERE status = 'published'` |
| alerts by community, status, publication date | `alerts_community_status_published_idx` |
| active alerts, emergencies first | `alerts_community_active_idx (community_id, severity_rank desc, published_at desc) WHERE status = 'published'` |
| alert expiry sweep | `alerts_due_expiry_idx (expires_at) WHERE status = 'published'` |
| undispatched alert events | `alert_events_undispatched_idx (occurred_at) WHERE dispatched_at IS NULL` |
| events by community and start time | `events_community_starts_idx (community_id, starts_at, id)` |
| events by community, status, start | `events_community_status_starts_idx` |
| RSVPs by event / by user | `event_rsvps_event_user_key` (leading), `event_rsvps_user_idx` |
| capacity count and waitlist order | `event_rsvps_going_idx`, `event_rsvps_waitlist_idx (event_id, waitlisted_at, id)` (partial) |
| a user's notifications, newest first | `notifications_user_created_idx (user_id, created_at desc, id desc)` |
| unread notifications | `notifications_user_unread_idx (user_id, read_at) WHERE archived_at IS NULL` |
| notifications by community | `notifications_community_created_idx (community_id, created_at desc)` (partial) |
| documents by community, status, date | `documents_community_created_idx (community_id, status, created_at desc, id desc)` |
| documents by folder | `documents_folder_idx` (partial) |
| document by storage path (storage policies) | `documents_storage_path_key` (unique) |
| audit log by community, newest first | `audit_logs_community_created_idx (community_id, created_at desc, id desc)` |
| system audit events | `audit_logs_system_created_idx` (partial) |
| audit by actor / by entity | `audit_logs_actor_created_idx`, `audit_logs_entity_idx` |
| communities.created_by + created_at | `communities_created_by_created_at_idx` (Stage 3: creation limit; FK `SET NULL` on account deletion) |
| invitations by community / creator / revoker | `invitations_community_created_idx`, `invitations_created_by_idx`, `invitations_revoked_by_idx` (partial) |
| invitation lookup by token | `invitations_token_hash_key` (unique) |
| redemptions by community / user / membership | `invitation_redemptions_community_idx`, `invitation_redemptions_user_idx`, `invitation_redemptions_membership_idx` |
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
| profiles | self (live session, any account status), platform admin, or the target has a membership the caller may see (see the memberships row) | ✗ (sign-up trigger) | self (active account) or platform admin; columns: names, avatar, bio | ✗ (only through `delete_my_account()` / account deletion) |
| platform_admins | ✗ | ✗ | ✗ | ✗ (server-side only) |
| communities | `community.view` | ✗ (only via `create_community()`) | `community.update`; columns: name, description, type, logo, cover, timezone, settings | ✗ |
| memberships | own row; `active` rows with `members.view`; other statuses with `members.approve`, `members.suspend` or `members.remove` (Stage 3) | ✗ (only `create_community()` and `redeem_invitation()`) | `status` only; transitions are checked by trigger (see below) | `members.remove`, not self, and the caller covers the target |
| roles | `roles.view` | `roles.manage`, custom roles only | `roles.manage`, custom roles only; name and description | `roles.manage`, custom roles, and the caller covers the role |
| membership_roles | own, or the membership is visible (as above) | `roles.manage`, not own membership, the caller covers the target membership **and** the role | ✗ | same as insert |
| role_permissions | `roles.view` in the role's community | `roles.manage`, custom role, and the caller holds that permission | ✗ | same as insert |
| permissions, role_templates, role_template_permissions | any authenticated user | ✗ | ✗ | ✗ |
| posts (Stage 5) | published: `posts.view`; hidden or deleted: `posts.moderate` or the author | `posts.create`, as yourself, always `published`; columns: community_id, body | author (`edit_own` / `delete_own`) or `posts.moderate`; columns: body, status, moderation_reason; trigger enforces the lifecycle | ✗ (soft delete) |
| comments (Stage 5) | post visible, and published, or `comments.moderate`, or the author | `comments.create` on a published visible post (published parent on the same post); columns: post_id, parent_comment_id, body | as posts, with `comments.*` | ✗ |
| announcements (Stage 6) | published or archived: `announcements.view` / `manage`; draft or deleted: `announcements.manage`, or the author holding `announcements.create` | `announcements.create`, as yourself, draft or published; columns: community_id, title, body, priority, status, expires_at | `announcements.manage`, or the author holding `announcements.create`; columns: title, body, priority, status, expires_at; trigger enforces the lifecycle | ✗ (soft delete) |
| alerts (Stage 7) | non-draft: `alerts.view` / `manage`; draft: `alerts.manage` or the creator holding `alerts.create` | `alerts.create`, as yourself, draft or published; `emergency` needs `alerts.manage` | `alerts.manage`, or the creator holding `alerts.create`; columns: title, body, severity, status, expires_at, cancellation_reason; trigger enforces lifecycle and severity rules | ✗ |
| alert_events (Stage 7) | `alerts.manage` | ✗ (trigger only) | ✗ | ✗ |
| events (Stage 8) | non-draft: `events.view` / `manage`; draft: `events.manage` or the creator holding `events.create` | `events.create`, as yourself, draft or published | `events.manage`, or the creator holding `events.create`; trigger enforces lifecycle and capacity | ✗ |
| event_rsvps (Stage 8) | own; `going` RSVPs of visible events; all with `events.manage` | own, while the event is published, not started, and you have `events.view`; status is sanitised by the capacity trigger | own, same conditions; `status` only | own, same conditions |
| notifications (Stage 9) | own, and (for membership-requiring types) only while the caller can view the community | ✗ (server-side service only) | own; `read_at`, `archived_at` only (server time) | own |
| notification_types (Stage 9) | any authenticated user | ✗ | ✗ | ✗ |
| documents (Stage 10) | active `members`: `documents.view` / `manage`; active `managers` or archived: `documents.manage`; pending or deleted: manager or uploader | ✗ (`create_document_upload()` only) | manager, or uploader with `documents.upload`; name, folder_id, visibility, status; trigger enforces rules | ✗ (soft delete) |
| document_folders (Stage 10) | `documents.view` / `manage` | `documents.manage` | `documents.manage` | `documents.manage` |
| storage.objects, bucket `documents` (Stage 10) | file of a visible active or archived document (and the uploader's own pending upload) | exact path of your own pending document, while you hold `documents.upload` | never (no replacement) | only abandoned pending uploads |
| audit_logs (Stage 11) | community events: `audit.view`; system events: platform admins | ✗ (database triggers / service only) | ✗ (never, any role) | ✗ (retention purge only) |
| audit_actions (Stage 11) | any authenticated user | ✗ | ✗ | ✗ |
| profile_private (Pre-Stage 12) | owner only (live session) | owner only (active account); column: phone | owner only; phone | owner only |
| invitations (Pre-Stage 12) | `members.invite`; every column **except** `token_hash` | ✗ (`create_invitation()` only) | ✗ (`revoke_invitation()` / `redeem_invitation()` only) | ✗ |
| invitation_redemptions (Pre-Stage 12) | own, or `members.invite` | ✗ (`redeem_invitation()` only) | ✗ | ✗ |
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

### Client RPCs (Stages 3–11 and Pre-Stage 12)

| Function | Returns | Notes |
|---|---|---|
| `public.create_community(...)` | the new community | Atomic. At most 10 per user per rolling 24 hours (`53400`). |
| `public.my_communities()` | the caller's pending, active and suspended memberships, with community basics and role names | SECURITY DEFINER, so pending and suspended members can see their status even though they cannot read `communities` |
| `public.my_community_permissions(community_id)` | the caller's permission keys | For UI gating only |
| `public.has_community_permission(community_id, key)` | boolean | Stage 1 |
| `public.list_community_posts(...)` / `public.list_post_comments(...)` | cursor-paginated pages | Stage 5, SECURITY INVOKER |
| `public.list_current_announcements(...)` / `public.list_announcement_history(...)` | cursor-paginated pages | Stage 6, SECURITY INVOKER |
| `public.list_active_alerts(...)` / `public.list_my_active_alerts()` / `public.list_alert_history(...)` | alerts, emergencies first | Stage 7, SECURITY INVOKER |
| `public.expire_due_alerts()` | count | Stage 7, **service role only** (scheduler) |
| `public.rsvp_to_event(event_id, status)` / `public.cancel_rsvp(event_id)` | stored status / boolean | Stage 8, SECURITY INVOKER; take the event lock first |
| `public.get_event_attendance(event_id)` | counts, my status, queue position | Stage 8, SECURITY DEFINER (totals only, visible events only) |
| `public.list_upcoming_events(...)` / `public.list_events(...)` | events | Stage 8, SECURITY INVOKER |
| `public.list_my_notifications(...)`, `unread_notification_count(...)`, `mark_notification_read / unread(id)`, `mark_all_notifications_read(...)`, `archive_notification(id)` | | Stage 9, SECURITY INVOKER |
| `public.create_notification(...)` | id | Stage 9, **service role only** |
| `public.create_document_upload(...)` / `public.complete_document_upload(id)` | path / document | Stage 10, SECURITY DEFINER, fully validated |
| `public.list_documents(...)` | documents | Stage 10, SECURITY INVOKER |
| `public.list_document_files_to_purge(retention)` | paths | Stage 10, **service role only** (purge job) |
| `public.list_audit_logs(...)` | audit entries | Stage 11, SECURITY INVOKER |
| `public.record_system_audit_event(...)` / `public.purge_audit_logs(interval)` | id / count | Stage 11, **service role only** |
| `public.get_reaction_summary(post_ids, comment_ids)` | counts per type | Stage 5, SECURITY INVOKER, at most 100 ids each |
| `public.admin_set_account_status(user_id, status)` | profile | Stage 2, platform admins only |
| `public.delete_my_account()` | void | Pre-Stage 12, SECURITY DEFINER; **no parameters**, deletes only the caller |
| `public.create_invitation(community_id, expires_in, max_uses)` | id, token (shown once), expires_at, max_uses | Pre-Stage 12, SECURITY DEFINER, `members.invite` |
| `public.revoke_invitation(id)` | boolean (false if already revoked) | Pre-Stage 12, SECURITY DEFINER, `members.invite` in that community |
| `public.redeem_invitation(token)` | community_id, membership_id, status | Pre-Stage 12, SECURITY DEFINER, row-locked and atomic |
| `public.list_invitations(community_id, include_inactive)` | invitations without hashes | Pre-Stage 12, SECURITY INVOKER |
| `public.expire_invitations()` | count | Pre-Stage 12, **service role only** (housekeeping) |

## Key security decisions

1. **Authorization resolves to permission keys, never role names.** Roles are
   labels that communities can rename or replace.
2. **SECURITY DEFINER only where needed:** `has_community_permission()`, the
   `private.*` lookup helpers, `create_community()` and the sign-up trigger.
   Each pins `search_path = ''`, takes the actor from `private.current_active_user_id()` (Stage 2) and never from
   a parameter, and runs no dynamic SQL. A test checks the `search_path` pinning.
3. **Helpers live in the `private` schema,** which the Supabase Data API does not
   expose, so clients cannot call them as RPCs.
4. **Clients cannot insert memberships.** Otherwise a community admin could
   "add" any user by UUID and then read that user's profile. Memberships come
   only from consent-based flows: creating a community, and redeeming an
   invitation (Pre-Stage 12), which the joining user does themselves.
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

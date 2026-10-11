# Alerts (Stage 7)

Urgent community notices, more urgent than announcements: emergencies, security
warnings, severe weather, infrastructure failures, urgent community-wide notices.
This stage builds the alert domain and its secure lifecycle. **No notifications
are delivered yet.** The integration point for that is below.

- **Migration:** `supabase/migrations/20261011001300_alerts.sql`
- **Tests:**
  - `supabase/tests/database/014_alerts.test.sql` (pgTAP, 69)
  - `tests/integration/alerts.test.mjs` (end to end, including the real service-role sweep)

## Tables

### `alerts`

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `community_id` | NOT NULL, FK → communities **RESTRICT**, immutable |
| `created_by` | NOT NULL. Session default, not client-writable. FK → profiles **ON DELETE RESTRICT** (see "Accountability" below). |
| `title` | 1–160 chars |
| `body` | 1–5 000 chars |
| `severity` | `info` \| `warning` \| `urgent` \| `emergency` (default `info`) |
| `severity_rank` | **Generated**: 1–4 |
| `is_emergency` | **Generated**: `severity = 'emergency'` |
| `status` | `draft` \| `published` \| `expired` \| `cancelled` \| `archived` |
| `published_at`, `published_by` | Server-stamped on publication |
| `expires_at` | Optional; must be in the future when publishing |
| `expired_at` | Server-stamped (manual expire or sweep) |
| `cancelled_at`, `cancelled_by`, `cancellation_reason` | Server-stamped on cancel. The reason is accepted only together with cancelling. |
| `archived_at`, `edited_at`, `updated_by_user_id` | Server-stamped |
| `created_at`, `updated_at` | |

**Indexes:**

| Index | Columns | Serves |
|---|---|---|
| `alerts_community_status_published_idx` | `(community_id, status, published_at desc, id desc)` | community, status and publication-date queries |
| `alerts_community_active_idx` | `(community_id, severity_rank desc, published_at desc) WHERE status = 'published'` | active alerts, emergencies first |
| `alerts_due_expiry_idx` | `(expires_at) WHERE status = 'published'` | the expiry sweep |
| `alerts_created_by_idx` | `created_by` | creator lookups |

### `alert_events` (notification outbox and audit trail)

| Column | Notes |
|---|---|
| `alert_id`, `community_id` | The alert, and its community |
| `event_type` | `published` \| `updated` \| `cancelled` \| `expired` |
| `severity` | Severity **at the time of the event** |
| `actor_user_id` | The user who caused it; NULL = system (e.g. the expiry sweep) |
| `occurred_at` | When it happened |
| `dispatched_at` | NULL until a future delivery worker processes it |

- Written **only** by the `alerts_record_event` trigger, in the same transaction as the alert change.
- Clients can never write to it.
- Readable by `alerts.manage` holders, as an audit trail.

## Severity

| Severity | Rank | Intended use | Who may set it |
|---|---|---|---|
| `info` | 1 | General notice | `alerts.create` |
| `warning` | 2 | Potential issue, e.g. severe weather watch | `alerts.create` |
| `urgent` | 3 | Act soon, e.g. infrastructure failure | `alerts.create` |
| `emergency` | 4 | Immediate danger, e.g. evacuate | **`alerts.manage` only** |

**Severity values from clients are never trusted:**

- The CHECK constraint accepts only the four values.
- **Emergency requires `alerts.manage`,** enforced twice for defence in depth:
  - by the INSERT policy;
  - by the `enforce_alert_write` trigger, which covers inserts, publishing and any
    change to or from `emergency`.
- **Changing severity after the draft stage requires `alerts.manage`,** so an
  author cannot quietly escalate or downgrade a live alert.
- `severity_rank` and `is_emergency` are **generated columns**. A client can
  neither supply them nor make them disagree with `severity`.

**Emergencies are clearly distinguishable:**

- `is_emergency` is set on every row;
- every list orders by `severity_rank desc`, so emergencies come first;
- `list_my_active_alerts()` returns the active alerts from **all** of the user's
  communities, emergencies first, for an app-wide banner.

## Lifecycle

```
draft ──publish──► published ──cancel───► cancelled ──archive──► archived (terminal)
  │                    └───────expire───► expired   ──archive──► archived
  └──discard (cancel, no notification)──► cancelled
```

| Action | Call | Rules |
|---|---|---|
| Save draft | `insert({ community_id, title, body, severity?, expires_at? })` | `alerts.create`; emergency needs `alerts.manage` |
| Create and publish at once | `insert({ ..., status: 'published' })` | As above. Stamps `published_at` and `published_by`. |
| Publish | `update({ status: 'published' })` | Only from `draft`. `expires_at` must be null or in the future. Emergency needs `alerts.manage`. |
| Edit | `update({ title, body, expires_at, severity })` | Only while `draft` or `published`. Severity changes after draft need `alerts.manage`. `expires_at` cannot be moved into the past (use expire). Edits to a published alert stamp `edited_at` and emit an `updated` event. |
| Cancel | `update({ status: 'cancelled', cancellation_reason })` | Retracts a published alert, or discards a draft. Stamps `cancelled_at` and `cancelled_by`. |
| Expire now | `update({ status: 'expired' })` | Only from `published`. Stamps `expired_at`. |
| Archive | `update({ status: 'archived' })` | Only from `cancelled` or `expired`. **Archived is terminal.** |
| Delete | not possible | Alerts are safety records; there is no DELETE privilege |

- Other transitions are rejected with `22023`.
- A cancelled or expired alert is never republished. Issue a new alert instead.

### Who can act on which alert

| Permission | Allows |
|---|---|
| `alerts.manage` | Any alert in the community |
| `alerts.create` | Only alerts you created, and only non-emergency severities |
| `alerts.view` | Read only |

Default roles: Owners and Admins hold all three; Moderators and Members hold
`alerts.view`. Communities can grant `alerts.create` alone to a custom role (for
example "Alerter"). Nothing checks a role name.

## Expiration

Expiry works at two levels:

1. **On read (always correct):** an alert is *active* only when
   `status = 'published'` and `expires_at` is null or in the future.
   `list_active_alerts`, `list_my_active_alerts` and `is_active` in the history
   all apply this, so an alert stops being active the moment it expires, even if
   nothing else runs.
2. **Recorded by a sweep:** `public.expire_due_alerts()` sets those alerts to
   `status = 'expired'` and emits an `expired` event with a system actor.
   - It returns the number of alerts expired.
   - It can be run by the **service role only**.
   - Schedule it, e.g. every minute, with `pg_cron` or a scheduled Edge Function:
     `select public.expire_due_alerts();`

## Visibility and RLS

**Alerts:**

| Status | Visible to |
|---|---|
| `published`, `expired`, `cancelled`, `archived` | `alerts.view` or `alerts.manage` in that community |
| `draft` | `alerts.manage`, or the creator while holding `alerts.create` |

**Event log:** `alert_events` is visible to `alerts.manage` holders only.

**Write policies:**

| Operation | Allowed when |
|---|---|
| INSERT | `created_by` is the session user, `status` is draft or published, the user has `alerts.create` in `community_id`, and an emergency also needs `alerts.manage` |
| UPDATE | `private.can_manage_alert_row()`: `alerts.manage`, or you are the creator and hold `alerts.create` |
| DELETE | Never |

The `enforce_alert_write` trigger then applies the lifecycle and severity rules.

All checks go through `has_community_permission()`, which requires a live
session, an active account, and an active membership in an active community.
Suspended administrators lose all alert powers immediately.

**Community isolation, tested at both the database and the API level:**

| Attempt | Result |
|---|---|
| Read another community's alert by id or by `community_id`, or through any list function | `[]` |
| Insert into another community, including an emergency | `42501` |
| Change `community_id` | `42501` |
| Cancel or edit another community's alert | 0 rows |

**Impersonation is not possible:**

- `created_by`, `published_by`, `cancelled_by` and `updated_by_user_id` are
  stamped from the validated session and are not client-writable.
- Server-side processes are recorded as a NULL actor, never as a user whose JWT
  claims happen to be lingering.

## Read API

```ts
// Active alerts in one community: emergencies first, then newest
const page = await supabase.rpc('list_active_alerts', { p_community_id, p_limit: 20 });
// next page: p_cursor_severity_rank, p_cursor_published_at, p_cursor_id from the last row

// Active alerts across all of my communities (banner), at most 50
await supabase.rpc('list_my_active_alerts');

// History: published, expired, cancelled, archived (managers may pass p_statuses: ['draft'])
await supabase.rpc('list_alert_history', { p_community_id, p_limit: 20 });
// next page: p_cursor_sort_at, p_cursor_id from the last row

// By id
await supabase.from('alerts').select('*').eq('id', alertId).single();
```

All list functions are `SECURITY INVOKER` (RLS applies) and use keyset
pagination, with page sizes capped at 50.

## Future notification integration

**Integration point:** `public.alert_events`, a transactional outbox. An event
row is committed **atomically with** the alert change, so an alert can never be
published without its event, or the reverse.

A future delivery worker should:

1. Read pending events:
   `select ... from alert_events where dispatched_at is null order by occurred_at for update skip locked`.
   Use the service role; the partial index `alert_events_undispatched_idx` supports this.
2. Resolve recipients: the active members of `community_id` holding `alerts.view`.
3. Choose channels by the event's `severity` (proposed policy below; to be
   decided in the notification stage).
4. Respect per-user notification preferences, except for `emergency`, which
   should bypass quiet hours.
5. Set `dispatched_at` once handed to the providers. Per-recipient delivery
   receipts belong in their own table.

| Severity | In-app | Push | Email | SMS |
|---|:-:|:-:|:-:|:-:|
| info | ✓ | | | |
| warning | ✓ | ✓ | | |
| urgent | ✓ | ✓ | ✓ | |
| emergency | ✓ | ✓ (bypasses quiet hours) | ✓ | ✓ |

How each event type should be delivered:

| Event | Delivery |
|---|---|
| `published` | Primary notification |
| `updated` | "Alert updated" (e.g. severity escalated) |
| `cancelled` | "Alert withdrawn": important so people stop acting on it |
| `expired` | Usually silent; clients refresh |

Delivery channels (push tokens, email and SMS providers) and user preferences are
**not** implemented in this stage.

## Accountability: `created_by` is `ON DELETE RESTRICT`

The specification requires `created_by` to be NOT NULL. Alerts are safety
records, so neither losing them (CASCADE) nor losing their creator (SET NULL) is
acceptable. As a result, **deleting the account of a user who created alerts is
blocked** until an operator deals with those alerts.

Options for that operator step have not been decided. They include reassigning
`created_by` to a designated system profile, or pseudonymising the account
instead of deleting it. This is recorded as an open decision.

## Known limitations

- No delivery (push, in-app, email, SMS), recipient resolution or preferences.
- No geographic or audience targeting within a community.
- No acknowledgement or "I'm safe" responses.
- The expiry sweep must be scheduled by operations (pg_cron or an Edge
  Function). Reads are correct without it.

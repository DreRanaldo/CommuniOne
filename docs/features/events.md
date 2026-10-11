# Events and RSVPs (Stage 8)

Community events with attendance tracking, capacity and a waitlist. There is no
ticketing and no payments. Every rule here is enforced in Postgres.

- **Migration:** `supabase/migrations/20261011001400_events.sql`
- **Tests:**
  - `supabase/tests/database/015_events.test.sql` (pgTAP, 72)
  - `tests/integration/events.test.mjs` (end to end, including 25 concurrent RSVPs)
  - `scripts/db/rsvp-stress.sh` (pgbench concurrency stress test, see below)

## Tables

### `events`

| Column | Notes |
|---|---|
| `community_id` | NOT NULL, FK **RESTRICT**, immutable |
| `created_by` | NOT NULL. Session default, not client-writable. FK → profiles **RESTRICT** (same accountability decision as alerts). |
| `title` | 1–200 chars |
| `description` | ≤ 10 000 chars |
| `location_text` | ≤ 500 chars |
| `starts_at`, `ends_at` | NOT NULL, with `ends_at >= starts_at` |
| `timezone` | IANA zone, validated by trigger. Default `UTC`. |
| `capacity` | NULL = unlimited, otherwise 1–100 000 |
| `status` | `draft` \| `published` \| `cancelled` \| `completed` |
| `published_at`, `cancelled_at`, `cancelled_by`, `completed_at`, `edited_at`, `updated_by_user_id` | Server-stamped |
| `cancellation_reason` | ≤ 500, only together with cancelling |
| `rsvp_changed_at` | Bumped by every RSVP write: this is the capacity lock (below) |

`UNIQUE (id, community_id)` is the target of the composite FK from RSVPs.

### `event_rsvps`

| Column | Notes |
|---|---|
| `event_id` | FK `(event_id, community_id)` → `events(id, community_id)` **CASCADE**: an RSVP can only belong to its event's community |
| `community_id` | Derived from the event by trigger; never client-supplied |
| `user_id` | Session default, not client-writable. FK → profiles **CASCADE**. |
| `status` | `going` \| `maybe` \| `not_going` \| `waitlisted` |
| `waitlisted_at` | Queue position. Server-maintained, set exactly while `waitlisted` (CHECK constraint). |
| `created_at`, `updated_at` | |

`UNIQUE (event_id, user_id)`: one RSVP per user per event.

### Indexes

| Need | Index |
|---|---|
| events by community and start time | `events_community_starts_idx (community_id, starts_at, id)` |
| events by status | `events_community_status_starts_idx (community_id, status, starts_at)` |
| events by creator | `events_created_by_idx` |
| RSVPs by event | `event_rsvps_event_user_key` (leading column) |
| RSVPs by user | `event_rsvps_user_idx` |
| capacity and waitlist | `event_rsvps_going_idx (event_id) WHERE going`, `event_rsvps_waitlist_idx (event_id, waitlisted_at, id) WHERE waitlisted` |

## Event lifecycle

```
draft ──publish──► published ──complete──► completed (terminal)
  │                    └──────cancel────► cancelled (terminal)
  └──discard (cancel)────────────────────► cancelled
```

| Action | Rules |
|---|---|
| Create | `events.create`. Status `draft` or `published`. |
| Publish | from `draft`; the event must not have ended already |
| Edit | title, description, location, times, timezone and capacity, only while `draft` or `published`. Edits to a published event stamp `edited_at`. |
| Cancel | from `draft` or `published`, with an optional reason. RSVPs are kept but frozen. |
| Complete | from `published`, once the event has started |
| Delete | not possible; cancel instead |

- Other transitions are rejected with `22023`.
- Changing a cancelled or completed event is rejected with `42501`.

## RSVP lifecycle

| Action | Call |
|---|---|
| RSVP or change it | `rpc('rsvp_to_event', { p_event_id, p_status: 'going' \| 'maybe' \| 'not_going' })` returns the **stored** status, which is `waitlisted` if the event is full |
| Cancel | `rpc('cancel_rsvp', { p_event_id })` returns `true` if an RSVP was removed |
| Attendance | `rpc('get_event_attendance', { p_event_id })` returns going, maybe, not-going and waitlisted counts, `spots_left`, `my_status` and `my_waitlist_position` |

- RSVPs are open while the event is **published and has not started**, to
  members holding `events.view`.
- After the event starts, or once it is cancelled or completed, RSVPs are frozen.
- `waitlisted` is **never** a client choice. The server assigns it.
- Direct table writes (`insert`, `update` or `delete` on `event_rsvps`) are
  allowed for your own RSVP and follow the same rules, but the RPCs are
  preferred (see "Lock ordering" below).

## Capacity and concurrency

Capacity is enforced inside the database for **every** RSVP write, whether it
comes from a client or from server code. The trigger
`private.apply_rsvp_capacity()` works as follows:

1. **Lock the event** with `UPDATE events SET rsvp_changed_at = …`. All RSVP
   writes for the same event are now serialized:
   - under **READ COMMITTED** (what the Data API uses), concurrent writers wait,
     then count with a fresh snapshot that includes the winner's row;
   - under **REPEATABLE READ or SERIALIZABLE**, a concurrent writer gets a
     serialization failure instead of counting stale data. (A plain
     `SELECT … FOR UPDATE` would not give this protection, which is why the lock
     is an UPDATE.)
2. **Count** the `going` RSVPs, under the lock.
3. If a new `going` would exceed capacity, store it as **`waitlisted`**.

No code path counts and then inserts outside the lock.

- **Lowering capacity** below the current number going is rejected (`22023`).
  The event's own row lock makes this check race-free.
- **Lock ordering:** `rsvp_to_event` and `cancel_rsvp` take the event lock
  *before* touching the RSVP row. Waitlist promotion holds the event lock and then
  updates RSVP rows, so the opposite order (direct `update` or `delete`) can
  deadlock under heavy contention. Postgres aborts one side, so capacity is never
  violated, but the client sees a retryable error. Use the RPCs.

### Waitlist rules

| Rule | Behaviour |
|---|---|
| Order | First come, first served by `(waitlisted_at, id)` |
| Freed place | When a `going` RSVP is cancelled or changed to `maybe` or `not_going`, the first waitlisted person is promoted to `going` in the same transaction |
| Larger capacity | Raising capacity (or removing it) promotes as many people as now fit, in order |
| Waiting | Asking for `going` again keeps your existing queue position |
| Rejoining | Leaving and rejoining puts you at the back |
| Queue position | `waitlisted_at` is not client-writable, so nobody can jump the queue |
| Visibility | `get_event_attendance` shows your 1-based queue position |

### Verification

- **pgTAP:** fills a capacity-2 event, then checks waitlisting, FIFO promotion on
  cancel and on a change to `not_going`, promotion when capacity is raised or
  removed, and that direct `going` inserts and updates cannot bypass the limit.
- **End to end:** 25 members RSVP **simultaneously** over separate API
  connections to a capacity-10 event. Exactly 10 end up going and 15 waitlisted.
- **`scripts/db/rsvp-stress.sh`** (pgbench; run after `scripts/db/test.sh`):

  | Phase | What runs | Invariants checked |
  |---|---|---|
  | Burst | 64 clients requesting `going` at once | exactly `capacity` going, plus a non-empty waitlist |
  | Mixed | 32 clients × 200 transactions of RSVP, change and cancel, under READ COMMITTED and REPEATABLE READ | going ≤ capacity; no free place while anyone waits; consistent queue rows |

  - READ COMMITTED must complete every transaction.
  - REPEATABLE READ may fail **only** with serialization errors.
  - Validated against a deliberately broken build without the lock: the burst
    produced **43 going against a capacity of 20**, and the script failed as
    intended.

## Authorization

| Permission | Allows |
|---|---|
| `events.view` | Read published, cancelled and completed events; RSVP; see attendance |
| `events.create` | Create events, and manage (edit, publish, cancel, complete) **your own** |
| `events.manage` | Manage **any** event in the community; see drafts and every RSVP |

Default roles: Owners and Admins hold all three; Moderators and Members hold
`events.view`. Communities can grant `events.create` alone to a custom
"Organizer" role. Nothing checks a role name.

## RLS

**Events:**

| Operation | Allowed when |
|---|---|
| SELECT | non-draft: `events.view` or `manage`; draft: `events.manage`, or the creator holding `events.create` |
| INSERT | `created_by` is the session user, status is draft or published, `events.create` |
| UPDATE | `events.manage`, or the creator holding `events.create`; the trigger enforces lifecycle and capacity rules |
| DELETE | never |

**RSVPs:**

| Operation | Allowed when |
|---|---|
| SELECT | your own; `going` RSVPs of events you can see (the attendee list); all RSVPs for `events.manage` |
| INSERT, UPDATE, DELETE | only your own (`user_id` is the session user), and only while `private.can_rsvp(event)`: published, not started, and `events.view` in the event's community |

- Other members' `maybe` and `not_going` answers stay private.
  `get_event_attendance` reports totals only.

**Cross-tenant isolation,** tested at both the database and the API level:

| Attempt | Result |
|---|---|
| Read another community's events or RSVPs, by id, by `community_id`, or through any list or attendance function | `[]` |
| RSVP to another community's event | `42501` |
| Create an event in another community | `42501` |
| Change `community_id` | `42501` |
| Cancel another community's event | 0 rows |
| `cancel_rsvp` on another community's event | no-op, and the event is not even locked |

## Read API

```ts
await supabase.rpc('list_upcoming_events', { p_community_id, p_limit: 20 });   // published, not ended, soonest first
await supabase.rpc('list_events', { p_community_id, p_from, p_to, p_statuses }); // calendar or history window
await supabase.from('events').select('*').eq('id', eventId).single();           // details
await supabase.rpc('get_event_attendance', { p_event_id: eventId });            // counts, my status and queue position
```

List functions are `SECURITY INVOKER` and paginate by keyset on
`(starts_at, id)`, at most 50 per page.

## Known limitations

- **Waitlist promotion is automatic and silent.** Notifying the promoted member
  belongs to the future notification stage.
- **No per-event attendee cap per member,** such as "+1 guests".
- **No ticketing, payments, recurring events or reminders.**
- **`updated_at` on events moves with RSVP activity,** because of the lock. Use
  `edited_at` for "details changed".
- **Account deletion is blocked for event creators.** `created_by` is
  `ON DELETE RESTRICT`, which is the open accountability decision shared with
  alerts.

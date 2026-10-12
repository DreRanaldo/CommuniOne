# Events and RSVPs in the Mobile App (RN-11)

Community events and attendance: browsing upcoming and past events, replying,
and creating and managing events with the event permissions. The backend is
Stage 8 (see [`events.md`](events.md)). One small read-only migration was
added (below).

- **Screens:** `apps/mobile/src/features/events/`
  - `EventsScreen`: Upcoming, Past and Drafts
  - `EventDetailScreen`: details, places, organizer, your reply, management
  - `EventEditorScreen`
- **Components and rules:**
  - `EventItem`: also used on the community home (it replaces the RN-06 home card)
  - `eventRules.ts`: time zones, status, RSVP and capacity wording, controls, form parsing, error messages
  - `useEventList.ts`
- **Migration 25:** `supabase/migrations/20261011002500_past_events.sql`
- **Service:** `events.listPast()`, `events.organizerName()`
- **Tests:**
  - `apps/mobile/src/features/events/events.test.tsx` (22)
  - `eventRules.test.ts` (6, including time-zone conversion across daylight saving)
  - `supabase/tests/database/026_past_events.test.sql` (pgTAP, 9)
  - `tests/services/events-ui.test.ts` (5, real Supabase)

## Migration 25: past events, newest first

`list_events()` pages in start order, oldest first. That suits a calendar
window, but a "Past" list would make members page through years of history
before reaching last week. `list_past_events()` returns events that are over,
**newest first**, with a keyset cursor on `(starts_at, id)` descending.

- "Over" means completed, or published / cancelled with an end time that has passed.
- Drafts are never listed.
- It is `SECURITY INVOKER`, so the existing events RLS decides what each caller
  receives. There is no new table, policy or privilege; `anon` cannot call it.

## Member experience

| View | Source | Contents |
|---|---|---|
| **Upcoming** | `list_events(from now, published + cancelled)` | Soonest first, including events in progress ("Happening now"). Cancelled ones stay, marked **Cancelled** and struck through, so people who planned to go find out |
| **Past** | `list_past_events()` | Newest first, marked **Completed** or **Ended** (or **Cancelled**) |
| **Detail** | `events.get` (RLS), `get_event_attendance`, the organizer's profile (RLS) | Title, status, date, time, time zone, location, places, organizer, cancellation reason, description, your reply |

**Time.** Dates and times are shown **in the event's time zone**, with the zone
named (e.g. "Europe/London"). When the device is in another zone, the detail
adds "Your time: …". Conversion uses the built-in `Intl` API (no date library).

**Organizer.** The creator's display name, read through the profiles RLS
(co-members with `members.view`, which every default role has). It shows
"Deleted User" when the account was deleted, and "A community member" when the
name is not visible.

## RSVP

| Choice | Result |
|---|---|
| Going | `going`, or **`waitlisted`** if the event is full: the server decides, atomically |
| Maybe / Not going | Stored as given; leaving `going` frees a place, and the first person waiting is promoted by the database |
| Remove my reply | `cancel_rsvp()`; frees a place the same way |

- **Places and the waitlist come from the server** (`get_event_attendance`):
  "4 of 10 places taken · 6 left", "Full · 2 of 2 places taken · 3 on the
  waitlist", or "7 going · No limit on places". Your own state is shown in
  words: "You're on the waitlist (number 2). You get a place automatically if
  one frees up."
- When the event is full and you are not going, a note says that choosing Going
  puts you on the waitlist.
- **Not optimistic.** Each reply waits for the server, then the event is re-read,
  so places, the waitlist and your status always match the database. While a
  reply is being saved the choices are locked: one request at a time.
- **Where permitted:** replies are open only while the event is published and
  has not started (the database's `can_rsvp`). Otherwise the screen says why:
  not published yet, cancelled, over, or started. If the server refuses
  (for example, cancelled meanwhile), the message explains it and the event is
  re-read.
- Waitlist promotion is silent for now. Notifying the promoted member belongs to
  the notifications stage.

## Event management

| Control | Shown when (display only) | Authorized by the database |
|---|---|---|
| "New" button | `events.create` | Insert RLS requires `events.create` |
| "Drafts" view | `events.create` or `events.manage` | Drafts are visible to managers (all) and organizers (their own) |
| Edit | Draft or published, and you may manage it | Trigger: only draft or published; published edits stamp `edited_at`; places cannot drop below the number going |
| Publish (asks first) | Draft that has not ended | `draft → published`; refused for an event that has ended |
| Discard (asks first) | Draft | `draft → cancelled` |
| Cancel event, with an optional reason (asks first) | Published | `published → cancelled`; RSVPs are kept but frozen |
| Mark completed (asks first) | Published and started | `published → completed`; refused before the start |

**"May manage it"** means `events.manage` for any event, or `events.create` for
**your own**. Members see none of these controls. Events are never deleted.
Nothing is optimistic; refusals are explained in plain words (`eventError`),
for example "More people are already going than that. Choose a larger number
of places."

**Editor.** It has these fields:
- Title.
- Date (`YYYY-MM-DD`), start and end time (`HH:MM`), and an optional end date
  for events that end on a later day.
- Time zone. It defaults to the community's zone, or the device's if that is
  not available. The times are wall-clock times in that zone.
- Location, places (empty means no limit), and description.

Everything is checked before sending (real date, real time, valid zone, end
after start, places 1–100 000) and again by the database. The editor sends the
community (always the current one) and the fields. The organizer, status dates
and capacity rules are set by the database. Editing resends the times only when
they were changed.

## Community isolation

- Lists are requested for the current community only. Rows of another
  community are dropped.
- The detail and the editor refuse an event that is not in the current community.
- Another community's event cannot be read (`NOT_FOUND`) or answered (`FORBIDDEN`).
  This is tested in the app, against real Supabase, and in pgTAP for `list_past_events`.
- Switching community remounts the community stack.

## Known limitations

- **Time zones on devices.** Time zones rely on `Intl` time-zone support in the
  JavaScript engine (Hermes on current React Native). Check this on a real
  device before release.
- **No pickers.** Date and time are typed (`YYYY-MM-DD`, `HH:MM`); no native
  picker was added, to keep dependencies minimal.
- **No attendee list** in the app yet (the backend exposes `going` RSVPs to members).
- **No reminders,** no calendar export, and no recurring events.

# Alerts in the Mobile App (RN-10)

Community alerts: reading them as a member, and issuing and managing them with
the alert permissions. The backend is Stage 7 (see [`alerts.md`](alerts.md));
no migration was needed. **Push notifications are not sent.** Delivery belongs
to RN-18; members see alerts in the app (home, Alerts list, detail).

- **Screens:** `apps/mobile/src/features/alerts/`
  - `AlertsScreen`: Active, History and Drafts
  - `AlertDetailScreen`
  - `AlertEditorScreen`
- **Components and rules:**
  - `AlertCard` and `SeverityBadge`: also used on the community home (they
    replace the RN-06 home card)
  - `alertRules.ts`: severity metadata, state, controls, end time, error messages
  - `useAlertList.ts`
- **Tests:**
  - `apps/mobile/src/features/alerts/alerts.test.tsx` (22)
  - `alertRules.test.ts` (5)
  - `apps/mobile/src/theme/contrast.test.ts` (10: WCAG AA for every severity colour)
  - `tests/services/alerts-ui.test.ts` (5, real Supabase)

## Where alerts appear

- **The Alerts tab** (feed redesign): the community's alerts, as described below.
- **Above the Home feed:** urgent and emergency alerts in force are pinned at the top of the feed (see [`feed-images.md`](feed-images.md)).
- **The community hub** (Communities tab): its Alerts section.

## Severity

Severity is never told by colour alone. Each level has its own icon, an
uppercase label, its own wording, and a spoken label ("Emergency alert: …").

| Level | Icon | Label | Meaning shown to members |
|---|---|---|---|
| Emergency | `alert-circle` (larger) | EMERGENCY | Immediate danger to life, health or property. Act now. |
| Urgent | `warning` | URGENT | Serious; act soon. |
| Warning | `warning-outline` | WARNING | May affect you; be prepared. |
| Information | `information-circle-outline` | INFORMATION | Good to know. |

**An active emergency** is a solid emergency-coloured block with inverse text,
the larger icon, a title in the `title` type style (22 pt bold) and an assertive
live region, so screen readers announce it at once. Its detail screen repeats
this in its header (`accessibilityRole="alert"`). Active urgent alerts get a
full severity-coloured border. A past emergency keeps its EMERGENCY label but is
drawn like any other past alert, so it no longer looks in force.

**Contrast.** Every severity colour meets WCAG AA (4.5:1) as text on the
surface, background and muted surface, in both themes, and the inverse text
meets it on the emergency colour. Two light-theme tokens were darkened for
this: warning `#B26A00` → `#9C5C00` (was 4.24:1), and emergency now uses
`red600 #C62828` instead of `danger #D32F2F` (was 4.37:1 on the muted surface).

## Member experience

| View | Source | Contents |
|---|---|---|
| **Active** | `list_active_alerts()` | Published and not past their end time; **emergencies first** (severity rank), then newest. "All clear right now." when empty |
| **History** | `list_alert_history()` | Every issued alert, newest first, each with its status: Active, Ended, Cancelled, Archived |
| **Detail** | `alerts.get` (RLS) | Severity header, title, meaning, status, dates, cancellation reason, body |

Dates: "Issued …", "Updated", "Ends …" or "Ended …", "Cancelled …", "Archived …",
in the community's time zone on the home and the device's elsewhere.

**Expiration.** An alert stops being active the moment its end time passes, even
before the server's expiry sweep marks it `expired`: the server's lists apply
the time, and the app shows such an alert as **Ended**.

## Authorized experience

| Control | Shown when (display only) | Authorized by the database |
|---|---|---|
| "New" button | `alerts.create` | Insert RLS requires `alerts.create` (emergency: also `alerts.manage`) |
| "Drafts" view | `alerts.create` or `alerts.manage` | Drafts are visible to managers (all) and creators (their own) |
| Emergency severity in the editor | `alerts.manage` | RLS and trigger: creating, publishing or setting emergency needs `alerts.manage` |
| Severity change after issue | `alerts.manage` | Trigger |
| Edit | Draft or published, and you may manage it | Trigger: only draft or published; published edits are stamped `edited_at` |
| Issue (asks first; stronger wording for emergencies) | Draft (emergency: manager only) | Trigger transition; `published_at` stamped; end time must be in the future |
| End now (asks first) | Published, `alerts.manage` only (RN-16) | `published → expired`; `expired_at` stamped; migration 30 refuses non-managers |
| Cancel alert, with an optional reason (asks first) | Published, `alerts.manage` only (RN-16) | `published → cancelled`; reason ≤ 500 characters, shown to members; migration 30 refuses non-managers |
| Discard (asks first) | Draft | `draft → cancelled` |
| Archive (asks first) | Ended or cancelled, `alerts.manage` only (RN-16) | Final: nothing can change an archived alert |

**"May manage it"** means `alerts.manage` for any alert, or `alerts.create` for
**your own**. Since RN-16 (migration 30), taking a published alert down (end,
cancel) or archiving it needs `alerts.manage` (Owners and Admins by default):
authors without it keep their drafts and can correct their published text only.
Members (who may send alerts since migration 31) get only "Edit" on their own published alerts, and the "Send a quick alert" button (see [`quick-alerts.md`](quick-alerts.md)). Alerts are never deleted.

Nothing is optimistic: each action waits for the server, then shows the result
("Issued. Members can see it now.", "Ended.", "Cancelled.", …). After a refusal
the alert is re-read and the message stays on screen. The editor sends only the
community (the current one), title, body, severity and end time. The creator,
status dates and severity rules are set and checked by the database. Editing
sends the severity and end time only when they were changed.

**Server refusals in plain words** (`alertError`):

| Refusal | Message |
|---|---|
| End time passed when issuing | "The end time has passed. Choose a later time or remove it." |
| Emergency without `alerts.manage` | "Only people who manage alerts can issue or change emergency alerts." |
| Invalid transition (changed elsewhere) | "This alert has changed meanwhile. Go back and open it again." |
| Permission removed meanwhile | "You don't have permission to change this alert." |
| Alert gone | "This alert is no longer available." |

**End time in the editor:** an optional date (`YYYY-MM-DD`) and time (`HH:MM`,
24 h) on the device; without a time, the end of that day. It is checked before
sending (format, real date and time, in the future), and the database checks it
again when issuing.

## Community isolation

- Lists are requested for the current community only. Rows of another
  community are dropped.
- The detail and the editor refuse an alert that is not in the current community.
- Switching community remounts the community stack.
- The community home's alert cards open the same detail screen, and "See all
  alerts" opens the list.

## Known limitations

- No push, email or SMS delivery (RN-18). Members only see alerts when they open the app.
- No app-wide emergency banner across communities yet (`listMyActive` exists for it).
- The end time uses the device's time zone in the editor.
- No acknowledgement ("I'm safe") or targeting within a community (backend limitation).

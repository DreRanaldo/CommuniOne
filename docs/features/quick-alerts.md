# Quick Alerts: Members Send Alerts, With Location and Photo

Members can warn their community at once. They pick what is happening
(one tap), can add details, their **current location** and a **photo** (camera
or library), and send. Every member is notified in the app immediately.

- **Migration 31:** `supabase/migrations/20261011003100_member_alerts_location_photo.sql`
- **Service:**
  - `alerts.create({ …, location?, image? })` takes two new optional fields.
  - `alerts.imageUrl(alert)` is new.
  - `ALERT_IMAGES_BUCKET` and `ALERT_IMAGE_MAX_BYTES` are new exports.
- **App:**
  - `apps/mobile/src/features/alerts/QuickAlertScreen.tsx`
  - `quickAlerts.ts` (the presets)
  - `AlertAttachments.tsx` (photo and map link on the alert)
  - `src/lib/location.ts`
  - `media.takePhoto()`
- **New dependency:** `expo-location ~57.0.21`, the SDK 57 version that `expo install` would choose.
- **Tests:**
  - `supabase/tests/database/031_member_alerts.test.sql` (32)
  - `tests/services/quick-alerts.test.ts` (4, real Supabase: actual storage upload and notifications)
  - `apps/mobile/src/features/alerts/quickAlert.test.tsx` (13)
  - Earlier tests that asserted "members cannot create alerts" were updated to the new rule.

## Where

The Quick alert screen opens from:
- the feed's **Alert** quick action ("Send a quick alert");
- the floating **+** → **Quick alert**;
- the **Send a quick alert** button at the top of the Alerts list.

The full editor (drafts, end time) stays under Alerts → New and Admin tools → New alert.

## The screen

1. **Banner:** "In danger? Call your local emergency number first. Alerts reach your community, not emergency services."
2. **What's happening?** One tap on a preset. The preset sets the title, the severity and a default message:

   | Preset | Severity |
   |---|---|
   | Suspicious activity | Warning |
   | Break-in or theft | Urgent |
   | Fire or smoke | Urgent |
   | Medical help needed | Urgent |
   | Road hazard | Warning |
   | Power or water outage | Info |
   | Lost or loose animal | Info |
   | Something else | Warning |
   | Community emergency (`alerts.manage` only) | Emergency |

3. **Details** (optional, ≤ 1000 characters).
4. **Share my current location** (optional). The position is read only when this is tapped, with foreground permission. The screen shows "Your current location will be shared · ±12 m", with a Remove button.
5. **Photo** (optional). "Take photo" uses the camera; "Choose photo" uses the library. The photo is re-encoded as JPEG, which strips EXIF and camera GPS.
6. **Send.** The screen says who will be notified:
   - urgent: "even if they muted alerts";
   - info or warning: members who get alerts.

   After sending, the alert opens with "Alert sent".

**On the alert itself**, everyone who can see it gets:
- the photo, through a short-lived signed link;
- "Location shared by the sender · ±12 m", with **Open in Maps** (a plain maps link; no map SDK and no API key).

## Rules (enforced by the database)

| Rule | Where |
|---|---|
| Members and Moderators hold `alerts.create`. Templates and every existing community's system roles were updated. | Migration 31 |
| Emergencies need `alerts.manage` (Owners, Admins) | Migration 13 (unchanged) |
| At most 20 alerts per user per hour | Rate limit, migration 21 |
| Only `alerts.manage` ends, cancels or archives a published alert, including one you sent yourself. Members keep "Edit" for corrections. | Migration 30 |
| The location is complete (latitude with longitude) and in range. It is set only at creation (no UPDATE grant). The app rounds it to 5 decimals (about 1 m). | Migration 31 |
| The photo must be the sender's own upload, in their own folder of that community (`alert-images/{community}/{user}/{uuid}.jpg`). It must exist, is set only at creation, and cannot be swapped or removed later. | `alerts_check_image` trigger, storage policies |
| Photo visibility: whoever can see the alert, and the uploader. Never outsiders: the bucket is private and there are no public URLs. | `private.can_read_alert_image_object` |
| Notifications: everyone else active in the community. Urgent and emergency alerts ignore notification mutes. | Migration 29 (unchanged) |

## Privacy

- **Location:**
  - read once, only after a tap;
  - never in the background (iOS and Android background location are off in `app.config.ts`);
  - never sent unless the sender keeps it;
  - visible only to the alert's audience;
  - the sender can remove it before sending.
- **Photos:** re-encoded on the device, so the camera's GPS metadata is never uploaded. Stored privately.
- **Device permission prompts:**

  | Platform | Prompt | Text |
  |---|---|---|
  | iOS | `NSLocationWhenInUseUsageDescription` | "only when you choose to share it on an alert" |
  | iOS | `NSCameraUsageDescription` | "only when you take a photo to add to an alert" |
  | Android | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | none: no background location |

## Opting out

A community that does not want members to send alerts can remove
`alerts.create` from its Member role (Admin Web or SQL). The app then hides
every Quick alert entry point, and the database refuses (tested).

## Known limitations

- **No push notifications yet.** The app's in-app notifications are immediate.
- **Feed cards** show the alert without its photo. The photo and location are on the alert screen; the list functions do not return them yet.
- **Leftover photos** (from a send that failed after upload) are removed by the app at once and listed by `list_alert_image_files_to_purge()` for a scheduled cleanup job, which still has to be scheduled.
- **Camera on Android:** confirm the camera prompt on a real device build. Tests use a scripted camera.

## Deploying

**Apply migration 31 to the hosted Supabase project:** `supabase db push`.

The migration creates the `alert-images` bucket. Migration 30 and earlier ones are needed too, if not yet applied.

Rebuild the native app: `expo-location` and the camera permission are native changes, so an over-the-air update is not enough.

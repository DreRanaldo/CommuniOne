# User Profile and Account (RN-03)

The signed-in user's own profile, private phone number, avatar and account
settings, in the mobile app and the backend underneath.

- **Migration:** `supabase/migrations/20261011002300_avatars.sql`
- **Service layer:** `services/auth/index.ts` (`getMyProfile`, `updateMyProfile`,
  `getMyPhone`, `setMyPhone`, `getMyAccount`, `changePassword`, `uploadMyAvatar`,
  `removeMyAvatar`, `avatarUrl`, `deleteMyAccount`). See [`../api/README.md`](../api/README.md).
- **Screens:** `apps/mobile/src/features/profile/`
- **Tests:**
  - `supabase/tests/database/024_avatars.test.sql` (pgTAP, 25)
  - `tests/services/profile.test.ts` (real Auth, Data API and Storage, 14)
  - `apps/mobile/src/features/profile/profile.test.tsx` (screens through the whole app, 29)

## What the user can do

| Screen | Contents |
|---|---|
| **Profile** (tab) | Avatar (or initials), display name, full name, bio, phone number marked "Private: only you can see your phone number". Buttons: Edit profile, Account & security. Reloads when the user comes back to it. |
| **Edit profile** | Add / change / remove photo (applied immediately). Display name, first name, last name, bio, phone number, saved together with "Save changes". Field validation, loading, error and retry states. |
| **Account & security** | Email, email confirmed, member since, last sign-in (from Auth). Change password. Sign out. Sign out of all devices (asks first). Delete account. |
| **Change password** | Current password, new password, confirmation. |
| **Delete account** | What is deleted and what is kept, a typed `DELETE` confirmation, then the backend deletion. |

## Profile fields

| Field | Stored in | Who can read it | Limits |
|---|---|---|---|
| Display name, first name, last name | `profiles` | The user, platform admins, co-members | ≤ 100 characters each |
| Bio | `profiles` | Same | ≤ 1000 characters |
| Avatar | `profiles.avatar_path` + `avatars` bucket | Same (signed URLs) | JPEG / PNG / WebP, ≤ 2 MiB |
| Phone number | `profile_private` | **The user only** | 5–32 characters: digits, spaces, `+ ( ) . -` |
| Email, account dates | `auth.users` | The user only | Changed only through Auth |

The app checks these limits for instant feedback (`features/profile/validation.ts`).
The service layer checks them again, and the database has the final say. Blank
fields are saved as `NULL`. Only the fields that changed are sent.

## Avatars

**Decision: a private bucket and signed URLs.** A profile is visible only to the
user, platform admins and co-members, and the photo follows the same rule. A
public bucket would let anyone with the URL see the photo forever, whatever
their membership. An avatar is shown through a signed URL that expires after an
hour (`services.auth.avatarUrl(profile)`). Signing is refused (`null`) for
anyone who may not see the profile.

```
avatars/{user_id}/{random uuid}.{jpg|png|webp}
```

| Rule | Mechanism |
|---|---|
| Upload only into your own folder, with an active account | `avatars_objects_insert` → `private.can_upload_avatar_object()` |
| No overwriting or moving files | No UPDATE policy; every new avatar is a new file (`upsert: false`) |
| Read = profile visibility | `avatars_objects_select` → `private.can_read_avatar_object()` (owner, platform admin, `can_view_profile`) |
| A profile can only point at your own uploaded file | `profiles_check_avatar` trigger (`42501` foreign or malformed path, `22023` not uploaded) |
| The current avatar cannot be deleted from under the profile | `avatars_objects_delete` → `private.can_delete_avatar_object()` (own files except the current one) |
| Old files go away | Replacing or removing deletes the previous file. Anything left over (failed clean-ups, deleted accounts) is listed by `list_avatar_files_to_purge()` for a scheduled service-role job ([`../deployment/supabase-auth.md`](../deployment/supabase-auth.md)). |
| Type and size | Bucket allow-list (`image/jpeg`, `image/png`, `image/webp`) and 2 MiB limit, also checked by the service layer |

**In the app** (`src/lib/media.ts`), the user picks a photo from the library
(`expo-image-picker`, photos permission only, no camera or microphone) and
crops it square. It is resized to 512 × 512 and re-encoded as JPEG
(`expo-image-manipulator`), which also drops EXIF metadata such as location.
The result is then uploaded. The picker is injected through `Dependencies.media`,
so tests use a fake.

`profiles.avatar_url` remains for external `https://` avatars from sign-up
metadata. `avatar_path` takes precedence.

## Phone number privacy

The phone number lives in `profile_private`, whose RLS allows only the owner.
The app reads and writes it with `getMyPhone()` / `setMyPhone()`, which take no
user id. It appears only on the user's own Profile and Edit profile screens. No
screen or request shows another member's number. See [`../architecture/privacy.md`](../architecture/privacy.md).

## Password and security

- **Change password:** `changePassword` re-checks the current password with
  Supabase Auth before updating, so someone holding an unlocked phone cannot
  take over the account. A wrong current password is a field error, not a
  sign-out. Passwords are held only in screen state and cleared after each
  attempt; they are never stored.
- **Sign out:** this device (`signOut('local')`), or every device after a
  confirmation (`signOut('global')`, which revokes all refresh tokens). Other
  devices lose access as soon as the database next checks their session.
- **Forgot password** stays on the sign-in screen (RN-02).

## Account deletion

Only the backend deletes accounts. The Delete account screen calls
`services.auth.deleteMyAccount()`, which runs the `delete_my_account()`
database function. That function takes no user id, deletes the session user
atomically and audits it. The app then signs out locally and shows "Your
account has been deleted". If the user is the only person who can manage a
community that still has other members, the function refuses (`CONFLICT`), and
the screen asks them to transfer it first. See
[`../architecture/account-deletion.md`](../architecture/account-deletion.md).

## Known limitations

- Feed and list RPCs (`list_community_posts()` and similar) return
  `author_avatar_url` only, not `avatar_path`, so uploaded avatars do not appear
  next to posts yet. They will need `avatar_path` in those RPCs, with signed URLs
  in batches (`createSignedUrls`), when those screens are built.
- Changing the email address is not offered yet; it needs Auth's
  confirm-both-addresses flow and its redirect URLs.
- Avatars are chosen from the photo library only. The camera is disabled, so the
  app asks for no camera or microphone permission.
- Signed URLs last an hour. The profile screen fetches a new one each time it
  loads.

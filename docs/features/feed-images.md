# Feed Redesign and Photo Posts

The mobile app now has a white, photo-first look, and the community feed is the
Home tab. Members can post pictures with a caption. This document covers the
redesign, the composer, and how post pictures are stored and protected.

- **Migration 26:** `supabase/migrations/20261011002600_post_images.sql`
- **Service:** `services/posts/index.ts`
  - `create` (now atomic and idempotent)
  - `uploadImage`, `discardImage`
  - `images`, `authorAvatars`
- **App:** `apps/mobile/src/features/feed/`
  - `FeedHeader`, `PostCard`, `PostImageGallery`
  - `FeedScreen`, `PostEditorScreen`, `useFeed`
  - photo picking in `src/lib/media.ts`
- **Tests:**
  - `apps/mobile/src/features/feed/photos.test.tsx` (17)
  - `supabase/tests/database/027_post_images.test.sql` (pgTAP, 37)
  - `tests/services/feed-images.test.ts` (5, real Supabase, including loading pictures through signed URLs)
  - existing feed, comments and navigation suites, updated

## What changed for members

| Before | Now |
|---|---|
| Tabs: Home (community hub), Notifications (placeholder), Profile | Tabs: **Home** (the feed), **Communities** (the hub), **Marketplace** (placeholder), **Alerts**, **Profile** |
| Feed one level below the hub, text cards on gray | The feed is the Home tab: white, edge-to-edge posts separated by hairlines |
| Text posts only | Posts with up to 10 photos and a caption |

- **Feed header:**
  - The community's logo and name with "Current community"; tap to switch community.
  - A "New post" button.
  - A "Share with your community" row with a photo button.
- **Alerts above the feed:** urgent and emergency alerts in force stay pinned at
  the top. They keep their RN-10 presentation: icon, label, solid emergency
  block, announced to screen readers. Tapping one opens it in the Alerts tab.
- **Post layout:**
  1. The author's picture and name, and the time ("2 hours ago").
  2. A "…" menu listing only the actions the viewer may take: edit, delete, hide or restore.
  3. The photos.
  4. Like and Comment.
  5. The caption, then "View all N comments".
- **Photos:**
  - Each post's photos sit in a frame shaped like its first photo, from portrait
    4:5 to landscape 1.91:1. Every photo is shown whole inside the frame, never
    cropped.
  - People swipe between photos, with a "1/3" counter and dots.
  - Screen readers hear "Photo 1 of 3, posted by …".
  - A photo that cannot be loaded says "Photo unavailable".
- **Switching community** remounts the Home, Communities and Alerts stacks, so
  nothing from the previous community (posts, photos, comments, reactions)
  stays on screen.

## Design system

- **Colours** (`apps/mobile/src/theme/tokens.ts`):
  - pure white background and surfaces (`#FFFFFF`), near-black text (`#121417`);
  - light-gray hairlines (`#E7E9ED`) and secondary text (`#5E6470`);
  - the logo blue as the one accent;
  - a `scrim` token for text over photos.
- **Light is the app's appearance** (`userInterfaceStyle: 'light'`). The dark
  tokens are kept for a later dark mode but are not used.
- **Readability:** `src/theme/contrast.test.ts` checks that every text colour,
  including the severity colours, meets WCAG AA (4.5:1) on the new surfaces.
- **Applies everywhere:** every screen reads the shared tokens (no screen
  hard-codes colours), so the hub, announcements, alerts, events, profile and
  the other screens all turned white with it. The tab bar and headers are white
  with hairline borders.

## Creating a post with pictures

1. Open the composer: "Add photos" (from the feed's photo button or in the
   composer), "New post", or the "Share with your community" row.
2. Pick photos. The system photo picker allows several at once, at most 10 per
   post, and needs no broad library permission. Each photo is re-encoded as
   JPEG with its long edge at most 2048 px. This keeps uploads small and strips
   metadata such as GPS location.
3. Previews appear in a strip; any photo can be removed before publishing.
   Photos over 10 MB are left out with a note.
4. Write a caption (required, at most 10 000 characters) and press **Post**.
5. Progress shows "Uploading photo 2 of 3…" with a bar, then "Publishing…".
6. **Retry without loss:**
   - A failed upload keeps the caption and the photos, marks the failed photo,
     and the button becomes **Try again**.
   - Photos already uploaded are never sent again.
   - If the connection drops after the server created the post, **Try again**
     sends the same request id, and the server returns that post instead of
     creating a second one.

Editing a photo post changes its caption only. A post's photos cannot be
changed after posting; this is enforced by the database.

## Storage and security

**Bucket:** `post-images`, **private**, 10 MB per file, JPEG / PNG / WebP only.
Files are stored at `post-images/{community_id}/{user_id}/{uuid}.{jpg|png|webp}`.

| Action | Who | Enforced by |
|---|---|---|
| Upload a file | Only into **your own folder** of a community where you hold `posts.create`, with an active account | Storage policy `post_images_objects_insert` |
| Overwrite or move a file | Nobody | No UPDATE policy |
| Read a file (signed URL) | Anyone who can see a post that uses it, and the uploader | Storage policy `post_images_objects_select`, following `can_view_post_row` (published: `posts.view`; hidden or deleted: moderators and the author) |
| Delete a file | The uploader, only while no post uses it | Storage policy `post_images_objects_delete` |
| Attach a picture to a post | Only through `create_post`, in the transaction that creates **your own** post, with a file you uploaded to **that community's** folder that exists | RLS on `post_images` and the trigger `private.check_post_image` (`posts.created_at = now()`) |
| Add, remove or change a post's pictures later | Nobody | No UPDATE or DELETE grant; the attach rule above |
| List pictures | Those who can see the post | RLS `post_images_select_visible` |

- **Private, short-lived links.** The app shows pictures through signed URLs
  that last one hour, created in one batch per feed page. Pictures are never
  made public. A link copied out of the app stops working.
- **Pictures follow the post.** When a moderator hides a post, members can no
  longer list its pictures or sign new links to them.
- **No service-role key** is used by the app. All access goes through the
  user's session and the policies above.
- **Account deletion:**
  - The author's posts are removed by cascade, and their `post_images` rows go
    with them.
  - The files are then unreferenced, and `list_post_image_files_to_purge()`
    (service role only) lists them for removal.
  - The same function lists abandoned uploads.

**`create_post(community_id, body, images, client_request_id)`** (`SECURITY INVOKER`):
- It creates the post and its pictures **atomically**: either all of them or
  nothing.
- It is **idempotent per author and request id**: the unique index
  `posts_author_client_request_key` also resolves concurrent retries.
- The usual rules apply: RLS on `posts`, the posts rate limit, and a caption of
  1–10 000 characters.

## Configuration required on a hosted Supabase project

- **Apply migration 26** (`supabase db push`, or the project's migration
  pipeline). The migration creates the `post-images` bucket and its policies;
  nothing needs to be set up by hand in the dashboard. I have **not** applied it
  to any hosted project.
- **Schedule the purge job,** like the avatar and community-media ones. A job
  using the service role should call `list_post_image_files_to_purge()` and
  delete the returned files through the Storage API. Without it, abandoned
  uploads stay in storage. They remain private (only their uploader can read
  them), so this costs storage space but is not a leak.

## Known limitations

- **Upload progress is per photo** (1 of 3, 2 of 3), not per byte: the
  Supabase upload call reports no byte progress.
- **Uploads are not rate-limited** separately (posts are). Abandoned files are
  removed by the purge job.
- **No camera capture** in the composer (library only), and no video.
- **A caption is required**, even with photos (the posts table requires text).
- **No deep link to a single post yet.** The post detail always re-reads the
  post through RLS and refuses one from another community, so a future link
  would be checked the same way.
- **Notifications** has no tab any more: the bell is now the community's
  Alerts. Notifications remains a placeholder screen in the code, for its own
  stage.
- **Dark mode** is off by design for now.

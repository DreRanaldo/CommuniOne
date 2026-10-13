# Stories (design pass)

A story is one photo, with an optional caption of up to 200 characters, shared
with **one community for 24 hours**. Stories appear as a row of round avatars
at the top of the Home feed. A coloured ring means "not seen yet"; a grey ring
means seen.

- **Migration 27:** `supabase/migrations/20261011002700_stories_and_stats.sql` (also adds the hub and profile counts; see below)
- **Service:** `services/stories/index.ts` (`list`, `imageUrls`, `uploadImage`, `discardImage`, `create`, `markViewed`, `delete`)
- **App:** `apps/mobile/src/features/stories/`
  - `StoriesBar`: the row in the feed header
  - `screens/StoryViewerScreen`: full screen, tap left or right, progress bars, moves on by itself after 6 s
  - `screens/StoryComposerScreen`: pick a photo, caption, share
  - `storyRules.ts`, `useStories.ts`
- **Tests:**
  - `supabase/tests/database/028_stories_and_stats.test.sql` (pgTAP, 59)
  - `tests/services/stories.test.ts` (9, real Supabase and Storage)
  - `apps/mobile/src/features/stories/stories.test.tsx` (13) and `storyRules.test.ts` (3)

## Who can do what

| Action | Allowed when |
|---|---|
| See a community's stories | `posts.view` in that community (the author always sees their own), while the story is **active**: not expired and not deleted |
| Add a story | `posts.create` in that community (same right as posting); 30 per hour (`story.create` rate rule) |
| Delete a story | its author, or a moderator (`posts.moderate`) |
| See who saw a story | nobody. The author gets a **count** only; each viewer reads only their own "seen" rows |

Expired and deleted stories are invisible to every client, including their
author, and so are their pictures.

## Storage

Files go in the private bucket `stories`, at
`stories/{community_id}/{user_id}/{random uuid}.{jpg|png|webp}`. The bucket
limits files to 10 MB and accepts JPEG, PNG and WebP only.

| Operation | Policy |
|---|---|
| Upload | your own folder of a community where you hold `posts.create` |
| Read (signed URL) | anyone who can see an active story using the file; the uploader, before publishing |
| Update / overwrite | never (no policy) |
| Delete | the uploader, only while no story uses the file (a discarded draft) |

The app shows pictures through **10-minute signed URLs**; the bucket is never public.

## Database

- `stories`
  - Columns: community, author, storage path (unique, format-checked), caption, width and height.
  - `client_request_id` is unique per author: a retried publish returns the first story.
  - `expires_at` is at most 24 hours after `created_at` (CHECK constraint).
  - `deleted_at` and `deleted_by` record a soft delete.
- `story_views`: `(story_id, viewer_user_id)`, once per viewer. RLS returns only your own rows.
- Clients have **no INSERT, UPDATE or DELETE** on either table. Writes go through these functions:
  - `create_story(community, path, width, height, caption?, client_request_id?)`. It checks:
    - the permission;
    - that the path is in your own folder of that community;
    - that the file was uploaded;
    - the caption and size;
    - the rate limit.
  - `delete_story(id)`: author or moderator; returns false when the story is not visible to you.
  - `mark_story_viewed(id)`: only stories you can see.
  - `list_community_stories(community)`: active stories with `viewed_by_me`, and `view_count` for your own.
    The order is your own first, then authors with unseen stories, then the newest.

## Purge (service role)

1. `list_story_files_to_purge(grace default 1 day)` lists files of stories that
   expired or were deleted more than the grace period ago, and uploads no story uses.
2. The job removes those files through the Storage API.
3. `purge_expired_stories(grace)` then deletes the story rows (and, by cascade,
   their views) whose files are gone.

Schedule it with the other purge jobs on the hosted project (for example an
Edge Function on a cron). Until it runs, expired pictures stay in Storage but
are unreadable.

## In the app

- **Bar:**
  - "Your story" comes first, with a **+** to add one, shown only with `posts.create`.
  - Then one bubble per author. The labels read "Story by Grace Hopper, new" or "…, seen".
- **Viewer:**
  - Opens at the author's first unseen story and continues through the next authors.
  - Each story shown is marked seen on the server.
  - It shows the author's name and age ("3h"), the caption, "Seen by N" on your own stories,
    and a delete control for the author or a moderator, with confirmation.
  - It reads the stories from the server again when opened, so a story deleted or expired
    meanwhile shows "This story is no longer available".
- **Composer:**
  - The photo picker re-encodes the photo to JPEG and strips location metadata.
  - The photo is uploaded once and then published with a request id, so "Try again" never
    duplicates a story.
  - Leaving without sharing deletes the uploaded photo.

## Known limitations

- Photos only (no video, text-only stories, stickers or replies).
- No "who viewed" list (counts only, by design).
- The 6-second auto-advance has no pause-on-hold yet.
- Stories are per community. Someone in several communities sees each community's stories in that community's feed.

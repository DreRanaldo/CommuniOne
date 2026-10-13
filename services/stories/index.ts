// Community stories: pictures shared with one community for 24 hours.
//
// Publish: uploadImage() into the caller's own folder of the community
// (private `stories` bucket; posts.create), then create() attaches it
// (create_story: checks the folder, the file and the permission; idempotent
// with clientRequestId). Members with posts.view see active stories through
// list() and signed URLs (imageUrls); expired and deleted stories are
// invisible to everyone. Views are private: authors only get a count.

import { ErrorCode, ServiceError } from '../core/errors.ts';
import { firstRow, unwrap, type ServiceContext } from '../core/context.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import * as v from '../core/validate.ts';
import type { Database } from '../database.types.ts';

export type Story = Database['public']['Functions']['list_community_stories']['Returns'][number];
export type StoryRow = Database['public']['Tables']['stories']['Row'];

export const STORIES_BUCKET = 'stories';
export const STORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const STORY_CAPTION_MAX = 200;
const STORY_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

const path = (value: unknown) => {
  if (typeof value !== 'string' || !STORY_PATH.test(value)) v.fail('path', 'The story picture path is invalid.');
  return value as string;
};

export function storiesService(ctx: ServiceContext) {
  const { db } = ctx;
  return {
    /** Active stories of a community (own first, then unseen authors), oldest first per author. */
    list(communityId: string): Promise<Story[]> {
      return ctx.run('stories.list', async () => {
        await ctx.requireUserId();
        const id = v.uuid(communityId, 'communityId');
        const rows = unwrap(await db.rpc('list_community_stories', { p_community_id: id })) ?? [];
        // Only this community's rows (defence in depth).
        return rows.filter((row) => row.community_id === id);
      });
    },

    /** Short-lived signed URLs for story pictures the caller may see (path → URL). */
    imageUrls(paths: string[], expiresInSeconds = 600): Promise<Record<string, string>> {
      return ctx.run('stories.imageUrls', async () => {
        await ctx.requireUserId();
        if (!Array.isArray(paths) || paths.length > 100) v.fail('paths', 'At most 100 pictures at a time.');
        const list = [...new Set(paths.map(path))];
        const seconds = v.int(expiresInSeconds, 'expiresInSeconds', 60, 3600);
        if (list.length === 0) return {};
        const signed = await db.storage.from(STORIES_BUCKET).createSignedUrls(list, seconds);
        const out: Record<string, string> = {};
        for (const item of signed.data ?? []) if (item.path && item.signedUrl && !item.error) out[item.path] = item.signedUrl;
        return out;
      });
    },

    /** Uploads a story picture (JPEG, PNG or WebP, at most 10 MB) to the caller's own folder. Requires posts.create. */
    uploadImage(input: { communityId: string; file: UploadBody; mimeType: ImageMimeType }): Promise<{ path: string }> {
      return ctx.run('stories.uploadImage', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'file', 'mimeType']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const { mimeType, ext } = checkImage(input, STORY_IMAGE_MAX_BYTES);
        const target = `${communityId}/${userId}/${randomId()}.${ext}`;
        const stored = await db.storage.from(STORIES_BUCKET).upload(target, uploadBody(input.file, mimeType), { contentType: mimeType, upsert: false });
        if (stored.error) {
          const status = Number((stored.error as { statusCode?: string | number }).statusCode ?? 0);
          if (status === 403 || /row-level security|unauthorized/i.test(stored.error.message)) {
            throw new ServiceError(ErrorCode.Forbidden, "You can't add stories in this community.", {}, stored.error);
          }
          throw new ServiceError(ErrorCode.ServerError, 'The picture could not be uploaded. Try again.', {}, stored.error);
        }
        return { path: target };
      });
    },

    /** Removes the caller's uploaded picture that no story uses (best effort; the purge job removes leftovers). */
    discardImage(imagePath: string): Promise<void> {
      return ctx.run('stories.discardImage', async () => {
        await ctx.requireUserId();
        await db.storage.from(STORIES_BUCKET).remove([path(imagePath)]);
      });
    },

    /** Publishes an uploaded picture as a story for 24 hours. Same clientRequestId on retry: no duplicate. */
    create(input: { communityId: string; path: string; width: number; height: number; caption?: string | null; clientRequestId?: string }): Promise<StoryRow> {
      return ctx.run('stories.create', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'path', 'width', 'height', 'caption', 'clientRequestId']);
        const caption = input.caption == null || input.caption.trim() === ''
          ? undefined
          : v.text(input.caption, 'caption', { max: STORY_CAPTION_MAX });
        return firstRow(unwrap(await db.rpc('create_story', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_path: path(input.path),
          p_width: v.int(input.width, 'width', 1, 20_000),
          p_height: v.int(input.height, 'height', 1, 20_000),
          p_caption: caption,
          p_client_request_id: input.clientRequestId === undefined ? undefined : v.uuid(input.clientRequestId, 'clientRequestId'),
        })));
      });
    },

    /** Records that the caller saw a story (false: not visible to them any more). */
    markViewed(storyId: string): Promise<boolean> {
      return ctx.run('stories.markViewed', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('mark_story_viewed', { p_story_id: v.uuid(storyId, 'storyId') })) === true;
      });
    },

    /** The author, or a moderator (posts.moderate). false: nothing the caller may see. */
    delete(storyId: string): Promise<boolean> {
      return ctx.run('stories.delete', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('delete_story', { p_story_id: v.uuid(storyId, 'storyId') })) === true;
      });
    },
  };
}

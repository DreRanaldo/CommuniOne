// Posts and reactions: create, edit, delete, moderate, read and react.
// Authorship comes from the session (author_user_id is not client-writable);
// moderators change status, never text (database trigger).

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, ServiceError } from '../core/errors.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables, TablesInsert } from '../database.types.ts';

export type Post = Tables<'posts'>;
export type FeedPost = Database['public']['Functions']['list_community_posts']['Returns'][number];

export const REACTION_TYPES = ['like', 'love', 'celebrate', 'support', 'laugh', 'sad'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const POST_STATUSES = ['published', 'hidden', 'deleted'] as const;

/** Private bucket for post pictures: {community_id}/{user_id}/{uuid}.{ext} (migration 26). */
export const POST_IMAGES_BUCKET = 'post-images';
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const POST_MAX_IMAGES = 10;
const AVATARS_BUCKET = 'avatars';

/** A picture to attach when creating a post: an uploaded file and its pixel size. */
export interface PostImageInput {
  path: string;
  width: number;
  height: number;
}

/** A post's picture, ready to display: a short-lived signed URL (null if it could not be signed). */
export interface PostImage {
  id: string;
  postId: string;
  path: string;
  position: number;
  width: number;
  height: number;
  url: string | null;
}

const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

const body = (value: unknown) => v.text(value, 'body', { max: 10_000 });
const reason = (value: unknown) => v.optionalText(value, 'reason', { max: 500 });

export function postsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, postId: string, patch: () => Database['public']['Tables']['posts']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const id = v.uuid(postId, 'postId');
      return mutateOne(
        () => db.from('posts').update(values).eq('id', id).select('*'),
        () => db.from('posts').select('id').eq('id', id),
        'Post not found.',
      );
    });

  return {
    /**
     * Requires posts.create in the community. Always published. Pictures must
     * have been uploaded first (uploadImage); the post and its pictures are
     * created together or not at all. Give the same clientRequestId when
     * retrying a publish: the server then returns the post the first attempt
     * created instead of creating a second one.
     */
    create(input: { communityId: string; body: string; images?: PostImageInput[]; clientRequestId?: string }): Promise<Post> {
      return ctx.run('posts.create', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'body', 'images', 'clientRequestId']);
        const images = input.images ?? [];
        if (!Array.isArray(images)) v.fail('images', 'images must be a list.');
        if (images.length > POST_MAX_IMAGES) v.fail('images', `A post can have at most ${POST_MAX_IMAGES} pictures.`);
        const pictures = images.map((image, i) => {
          v.only<PostImageInput>(image, `images[${i}]`, ['path', 'width', 'height']);
          if (typeof image.path !== 'string' || !IMAGE_PATH.test(image.path)) v.fail('images', 'A picture path is invalid.');
          return { path: image.path, width: v.int(image.width, 'width', 1, 20_000), height: v.int(image.height, 'height', 1, 20_000) };
        });
        const rows = unwrap(await db.rpc('create_post', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_body: body(input.body),
          p_images: pictures,
          p_client_request_id: input.clientRequestId === undefined ? undefined : v.uuid(input.clientRequestId, 'clientRequestId'),
        }));
        const post = rows?.[0];
        if (!post) throw new ServiceError(ErrorCode.ServerError, 'The post could not be created.');
        return post;
      });
    },

    /**
     * Uploads one picture (JPEG, PNG or WebP, at most 10 MB) to the caller's
     * own folder of the community, in the private post-images bucket. Attach
     * it with create({ images }). Requires posts.create there.
     */
    uploadImage(input: { communityId: string; file: UploadBody; mimeType: ImageMimeType }): Promise<{ path: string }> {
      return ctx.run('posts.uploadImage', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'file', 'mimeType']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const { mimeType, ext } = checkImage(input, POST_IMAGE_MAX_BYTES);
        const path = `${communityId}/${userId}/${randomId()}.${ext}`;
        const stored = await db.storage.from(POST_IMAGES_BUCKET).upload(path, uploadBody(input.file, mimeType), { contentType: mimeType, upsert: false });
        if (stored.error) {
          const status = Number((stored.error as { statusCode?: string | number }).statusCode ?? 0);
          if (status === 403 || /row-level security|unauthorized/i.test(stored.error.message)) {
            throw new ServiceError(ErrorCode.Forbidden, "You can't post pictures in this community.", {}, stored.error);
          }
          throw new ServiceError(ErrorCode.ServerError, 'The picture could not be uploaded. Try again.', {}, stored.error);
        }
        return { path };
      });
    },

    /** Removes the caller's uploaded picture that no post uses (best effort; a purge job removes leftovers). */
    discardImage(path: string): Promise<void> {
      return ctx.run('posts.discardImage', async () => {
        await ctx.requireUserId();
        if (typeof path !== 'string' || !IMAGE_PATH.test(path)) v.fail('path', 'The picture path is invalid.');
        await db.storage.from(POST_IMAGES_BUCKET).remove([path]);
      });
    },

    /**
     * The pictures of up to 100 posts, in order, with signed URLs (one query,
     * one signing call). Only pictures of posts the caller can see are returned.
     */
    images(postIds: string[], expiresInSeconds = 3600): Promise<Record<string, PostImage[]>> {
      return ctx.run('posts.images', async () => {
        await ctx.requireUserId();
        const ids = v.uuidList(postIds, 'postIds', 100);
        const seconds = v.int(expiresInSeconds, 'expiresInSeconds', 60, 86_400);
        if (ids.length === 0) return {};
        const rows = unwrap(await db.from('post_images').select('id, post_id, storage_path, position, width, height')
          .in('post_id', ids).order('position')) ?? [];
        const urls = new Map<string, string>();
        if (rows.length > 0) {
          const signed = await db.storage.from(POST_IMAGES_BUCKET).createSignedUrls(rows.map((r) => r.storage_path), seconds);
          for (const item of signed.data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
        }
        const byPost: Record<string, PostImage[]> = {};
        for (const r of rows) {
          (byPost[r.post_id] ??= []).push({
            id: r.id, postId: r.post_id, path: r.storage_path, position: r.position,
            width: r.width, height: r.height, url: urls.get(r.storage_path) ?? null,
          });
        }
        return byPost;
      });
    },

    /**
     * Profile pictures of up to 100 authors (people the caller may see: profiles
     * RLS), as signed URLs for uploaded avatars or the external avatar_url.
     */
    authorAvatars(userIds: string[], expiresInSeconds = 3600): Promise<Record<string, string | null>> {
      return ctx.run('posts.authorAvatars', async () => {
        await ctx.requireUserId();
        const ids = [...new Set(v.uuidList(userIds, 'userIds', 100))];
        const seconds = v.int(expiresInSeconds, 'expiresInSeconds', 60, 86_400);
        if (ids.length === 0) return {};
        const rows = unwrap(await db.from('profiles').select('id, avatar_path, avatar_url').in('id', ids)) ?? [];
        const paths = rows.map((r) => r.avatar_path).filter((p): p is string => !!p);
        const urls = new Map<string, string>();
        if (paths.length > 0) {
          const signed = await db.storage.from(AVATARS_BUCKET).createSignedUrls(paths, seconds);
          for (const item of signed.data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
        }
        return Object.fromEntries(rows.map((r) => [r.id, (r.avatar_path ? urls.get(r.avatar_path) : r.avatar_url) ?? null]));
      });
    },

    /** One post the caller can see. */
    get(postId: string): Promise<Post> {
      return ctx.run('posts.get', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('posts').select('*').eq('id', v.uuid(postId, 'postId')).maybeSingle(), 'Post not found.');
      });
    },

    /** Feed, newest first, with author, counts and my reaction. Moderators may list hidden or deleted posts. */
    list(input: { communityId: string; status?: (typeof POST_STATUSES)[number] } & PageRequest): Promise<Page<FeedPost>> {
      return ctx.run('posts.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'status', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_community_posts', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_limit: limit,
          p_cursor_created_at: (cursor?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (cursor?.[1] as string | undefined) ?? undefined,
          p_status: input.status === undefined ? 'published' : v.oneOf(input.status, 'status', POST_STATUSES),
        }));
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },

    /** Authors edit their own published posts (posts.edit_own). */
    edit: (postId: string, newBody: string) => update('posts.edit', postId, () => ({ body: body(newBody) })),
    /** Authors delete their own posts (posts.delete_own); moderators may too. Soft delete. */
    delete: (postId: string) => update('posts.delete', postId, () => ({ status: 'deleted' })),
    /** posts.moderate: hide with an optional reason shown to the author. */
    hide: (postId: string, why?: string) => update('posts.hide', postId, () => ({ status: 'hidden', moderation_reason: reason(why) ?? null })),
    /** posts.moderate: restore a hidden post. */
    restore: (postId: string) => update('posts.restore', postId, () => ({ status: 'published' })),

    /** Adds or changes the caller's reaction on a post or comment. */
    react(input: { postId?: string; commentId?: string; type: ReactionType }): Promise<void> {
      return ctx.run('posts.react', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['postId', 'commentId', 'type']);
        const type = v.oneOf(input.type, 'type', REACTION_TYPES);
        const postId = v.optionalUuid(input.postId, 'postId');
        const commentId = v.optionalUuid(input.commentId, 'commentId');
        if ((postId === null) === (commentId === null)) v.fail('postId', 'Give exactly one of postId or commentId.');
        const target = postId ? { column: 'post_id', id: postId } as const : { column: 'comment_id', id: commentId as string } as const;
        const existing = unwrap(await db.from('reactions').select('id')
          .eq(target.column, target.id).eq('user_id', userId).maybeSingle());
        const change = () => db.from('reactions').update({ reaction_type: type }).eq(target.column, target.id).eq('user_id', userId);
        if (existing) {
          unwrap(await change());
        } else {
          // community_id is derived from the target by trigger.
          const inserted = await db.from('reactions').insert({ [target.column]: target.id, reaction_type: type } as unknown as TablesInsert<'reactions'>);
          // A concurrent request created the reaction first (one per user and
          // target, unique index): this one becomes a change of type instead.
          if (inserted.error?.code === '23505') unwrap(await change());
          else unwrap(inserted);
        }
      });
    },

    unreact(input: { postId?: string; commentId?: string }): Promise<void> {
      return ctx.run('posts.unreact', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['postId', 'commentId']);
        const postId = v.optionalUuid(input.postId, 'postId');
        const commentId = v.optionalUuid(input.commentId, 'commentId');
        if ((postId === null) === (commentId === null)) v.fail('postId', 'Give exactly one of postId or commentId.');
        const query = db.from('reactions').delete().eq('user_id', userId);
        unwrap(await (postId ? query.eq('post_id', postId) : query.eq('comment_id', commentId as string)));
      });
    },

    /** Reaction counts for up to 100 posts and 100 comments in one call (no N+1). */
    reactionSummary(input: { postIds?: string[]; commentIds?: string[] }) {
      return ctx.run('posts.reactionSummary', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['postIds', 'commentIds']);
        return unwrap(await db.rpc('get_reaction_summary', {
          p_post_ids: v.uuidList(input.postIds ?? [], 'postIds', 100),
          p_comment_ids: v.uuidList(input.commentIds ?? [], 'commentIds', 100),
        })) ?? [];
      });
    },
  };
}

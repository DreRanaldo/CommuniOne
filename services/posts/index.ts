// Posts and reactions: create, edit, delete, moderate, read and react.
// Authorship comes from the session (author_user_id is not client-writable);
// moderators change status, never text (database trigger).

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables, TablesInsert } from '../database.types.ts';

export type Post = Tables<'posts'>;
export type FeedPost = Database['public']['Functions']['list_community_posts']['Returns'][number];

export const REACTION_TYPES = ['like', 'love', 'celebrate', 'support', 'laugh', 'sad'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const POST_STATUSES = ['published', 'hidden', 'deleted'] as const;

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
    /** Requires posts.create in the community. Always published. */
    create(input: { communityId: string; body: string }): Promise<Post> {
      return ctx.run('posts.create', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'body']);
        return unwrapOne(await db.from('posts')
          .insert({ community_id: v.uuid(input.communityId, 'communityId'), body: body(input.body) })
          .select('*').maybeSingle());
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

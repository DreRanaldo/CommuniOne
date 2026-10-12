// Comments: create (including replies), edit, delete, moderate and list.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables, TablesInsert } from '../database.types.ts';

export type Comment = Tables<'comments'>;
export type ThreadComment = Database['public']['Functions']['list_post_comments']['Returns'][number];

const body = (value: unknown) => v.text(value, 'body', { max: 5_000 });

export function commentsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, commentId: string, patch: () => Database['public']['Tables']['comments']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const id = v.uuid(commentId, 'commentId');
      return mutateOne(
        () => db.from('comments').update(values).eq('id', id).select('*'),
        () => db.from('comments').select('id').eq('id', id),
        'Comment not found.',
      );
    });

  return {
    /** comments.create on a published, visible post; replies only to published comments on the same post. */
    create(input: { postId: string; body: string; parentCommentId?: string }): Promise<Comment> {
      return ctx.run('comments.create', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['postId', 'body', 'parentCommentId']);
        return unwrapOne(await db.from('comments').insert({
          post_id: v.uuid(input.postId, 'postId'),
          parent_comment_id: v.optionalUuid(input.parentCommentId, 'parentCommentId'),
          body: body(input.body),
        } as TablesInsert<'comments'>).select('*').maybeSingle()); // community_id is derived from the post by trigger
      });
    },

    /** Oldest first: top-level comments of a post, or the replies to one comment. */
    list(input: { postId: string; parentCommentId?: string } & PageRequest): Promise<Page<ThreadComment>> {
      return ctx.run('comments.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['postId', 'parentCommentId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_post_comments', {
          p_post_id: v.uuid(input.postId, 'postId'),
          p_parent_comment_id: v.optionalUuid(input.parentCommentId, 'parentCommentId') ?? undefined,
          p_limit: limit,
          p_cursor_created_at: (cursor?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (cursor?.[1] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },

    edit: (commentId: string, newBody: string) => update('comments.edit', commentId, () => ({ body: body(newBody) })),
    delete: (commentId: string) => update('comments.delete', commentId, () => ({ status: 'deleted' })),
    hide: (commentId: string, why?: string) =>
      update('comments.hide', commentId, () => ({ status: 'hidden', moderation_reason: v.optionalText(why, 'reason', { max: 500 }) ?? null })),
    restore: (commentId: string) => update('comments.restore', commentId, () => ({ status: 'published' })),
  };
}

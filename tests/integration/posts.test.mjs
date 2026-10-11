// Stage 5: posts, comments and reactions through the real Data API.
//
//   Community A                         Community B
//     ownerA  Owner                       ownerB  Owner
//     modA    Moderator                   memberB Member
//     memberA Member
//     member2 Member
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

after(async () => {
  // Content is removed with its authors / communities.
  for (const id of Object.values(c)) {
    await admin.from('reactions').delete().eq('community_id', id);
    await admin.from('comments').delete().eq('community_id', id);
    await admin.from('posts').delete().eq('community_id', id);
  }
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const p = {};
const cm = {};

const createPost = async (user, communityId, body) =>
  user.client.from('posts').insert({ community_id: communityId, body }).select('id, author_user_id, status').single();

const statusOf = async (table, id) => (await admin.from(table).select('status').eq('id', id).single()).data?.status;

before(async () => {
  for (const name of ['ownerA', 'modA', 'memberA', 'member2', 'ownerB', 'memberB']) {
    const user = await createConfirmedUser(name.toLowerCase(), { display_name: name });
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Posts ${key}`,
      p_slug: `posts-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.modA.id, 'Moderator');
  await addMember(c.A, u.memberA.id, 'Member');
  await addMember(c.A, u.member2.id, 'Member');
  await addMember(c.B, u.memberB.id, 'Member');
});

describe('posts', () => {
  test('1. a member creates a post; the author is taken from the session', async () => {
    const { data, error } = await createPost(u.memberA, c.A, 'Hello neighbours');
    assert.equal(error, null);
    assert.equal(data.author_user_id, u.memberA.id);
    assert.equal(data.status, 'published');
    p.memberA = data.id;
    p.ownerA = (await createPost(u.ownerA, c.A, 'Welcome to A')).data.id;
    p.memberB = (await createPost(u.memberB, c.B, 'Hello from B')).data.id;
  });

  test('1. a member cannot forge the author or the status', async () => {
    const forged = await u.memberA.client.from('posts').insert({ community_id: c.A, body: 'x', author_user_id: u.member2.id });
    assert.equal(forged.error?.code, '42501');
    const hidden = await u.memberA.client.from('posts').insert({ community_id: c.A, body: 'x', status: 'hidden' });
    assert.equal(hidden.error?.code, '42501');
  });

  test('2. a non-member cannot post (changing the community id)', async () => {
    const { error } = await createPost(u.memberB, c.A, 'Intruder');
    assert.equal(error?.code, '42501');
  });

  test('3. a member reads her community\'s posts, individually and as a feed', async () => {
    const { data: one, error } = await u.member2.client
      .from('posts')
      .select('id, body, profiles!posts_author_user_id_fkey(display_name)')
      .eq('id', p.memberA)
      .single();
    assert.equal(error, null);
    assert.equal(one.profiles.display_name, 'memberA');

    const { data: feed } = await u.member2.client.rpc('list_community_posts', { p_community_id: c.A });
    assert.deepEqual(feed.map((r) => r.id).sort(), [p.memberA, p.ownerA].sort());
  });

  test('4. a user cannot read another community\'s posts by post id or community id', async () => {
    assert.deepEqual((await u.memberB.client.from('posts').select('id').eq('id', p.memberA)).data, []);
    assert.deepEqual((await u.memberB.client.from('posts').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await u.memberB.client.rpc('list_community_posts', { p_community_id: c.A })).data, []);
  });

  test('5. a user edits her own post', async () => {
    const { data } = await u.memberA.client.from('posts').update({ body: 'Hello neighbours!' }).eq('id', p.memberA).select('body, edited_at');
    assert.equal(data[0].body, 'Hello neighbours!');
    assert.ok(data[0].edited_at);
  });

  test('6. a user cannot edit or delete another user\'s post', async () => {
    assert.deepEqual((await u.member2.client.from('posts').update({ body: 'defaced' }).eq('id', p.memberA).select()).data, []);
    assert.deepEqual((await u.member2.client.from('posts').update({ status: 'deleted' }).eq('id', p.memberA).select()).data, []);
    assert.deepEqual((await u.ownerB.client.from('posts').update({ status: 'hidden' }).eq('id', p.memberA).select()).data, [], 'Owner of B has no power in A');
    assert.equal(await statusOf('posts', p.memberA), 'published');
  });

  test('6. nobody can hard-delete a post or move it to another community', async () => {
    assert.equal((await u.memberA.client.from('posts').delete().eq('id', p.memberA)).error?.code, '42501');
    assert.equal((await u.memberA.client.from('posts').update({ community_id: c.B }).eq('id', p.memberA)).error?.code, '42501');
  });

  test('7. a moderator hides and restores a post, but cannot rewrite it', async () => {
    const rewrite = await u.modA.client.from('posts').update({ body: 'moderator words' }).eq('id', p.memberA);
    assert.equal(rewrite.error?.code, '42501');

    const { data, error } = await u.modA.client
      .from('posts')
      .update({ status: 'hidden', moderation_reason: 'Please keep it on topic' })
      .eq('id', p.memberA)
      .select('status, moderated_by_user_id');
    assert.equal(error, null);
    assert.deepEqual(data, [{ status: 'hidden', moderated_by_user_id: u.modA.id }]);
  });

  test('14. hidden posts: invisible to members, visible to the author and moderators', async () => {
    assert.deepEqual((await u.member2.client.from('posts').select('id').eq('id', p.memberA)).data, []);
    const { data: own } = await u.memberA.client.from('posts').select('status, moderation_reason').eq('id', p.memberA).single();
    assert.deepEqual(own, { status: 'hidden', moderation_reason: 'Please keep it on topic' });
    const { data: modFeed } = await u.modA.client.rpc('list_community_posts', { p_community_id: c.A, p_status: 'hidden' });
    assert.deepEqual(modFeed.map((r) => r.id), [p.memberA]);
    const { data: memberFeed } = await u.member2.client.rpc('list_community_posts', { p_community_id: c.A, p_status: 'hidden' });
    assert.deepEqual(memberFeed, []);
    const unhide = await u.memberA.client.from('posts').update({ status: 'published' }).eq('id', p.memberA);
    assert.equal(unhide.error?.code, '42501', 'authors cannot un-hide their own posts');
  });

  test('7. the moderator restores the post', async () => {
    const { data } = await u.modA.client.from('posts').update({ status: 'published' }).eq('id', p.memberA).select('status');
    assert.deepEqual(data, [{ status: 'published' }]);
  });
});

describe('comments', () => {
  test('8. a member comments and replies (threaded)', async () => {
    const { data: top, error } = await u.member2.client
      .from('comments').insert({ post_id: p.ownerA, body: 'Great to be here' }).select('id, depth, community_id').single();
    assert.equal(error, null);
    assert.equal(top.depth, 0);
    assert.equal(top.community_id, c.A);
    cm.member2 = top.id;

    const { data: reply } = await u.memberA.client
      .from('comments').insert({ post_id: p.ownerA, parent_comment_id: cm.member2, body: 'Same!' }).select('id, depth').single();
    assert.equal(reply.depth, 1);
    cm.memberAReply = reply.id;
  });

  test('a reply must stay in the same post (changing the post id)', async () => {
    const { error } = await u.memberA.client.from('comments').insert({ post_id: p.memberA, parent_comment_id: cm.member2, body: 'x' });
    assert.ok(error);
  });

  test('9. a user cannot comment in another community (post id or parent id from A)', async () => {
    const onPost = await u.memberB.client.from('comments').insert({ post_id: p.ownerA, body: 'from B' });
    assert.equal(onPost.error?.code, '42501');
    const graft = await u.memberB.client.from('comments').insert({ post_id: p.memberB, parent_comment_id: cm.member2, body: 'graft' });
    assert.ok(graft.error, 'a parent from community A cannot be used in community B');
    assert.deepEqual((await u.memberB.client.from('comments').select('id').eq('id', cm.member2)).data, [], 'comment id lookup reveals nothing');
    assert.deepEqual((await u.memberB.client.rpc('list_post_comments', { p_post_id: p.ownerA })).data, []);
  });

  test('10. a user edits her own comment', async () => {
    const { data } = await u.member2.client.from('comments').update({ body: 'Great to be here!' }).eq('id', cm.member2).select('body, edited_at');
    assert.equal(data[0].body, 'Great to be here!');
    assert.ok(data[0].edited_at);
  });

  test('11. a user cannot edit or delete another user\'s comment', async () => {
    assert.deepEqual((await u.memberA.client.from('comments').update({ body: 'changed' }).eq('id', cm.member2).select()).data, []);
    assert.deepEqual((await u.memberA.client.from('comments').update({ status: 'deleted' }).eq('id', cm.member2).select()).data, []);
    assert.deepEqual((await u.memberB.client.from('comments').update({ body: 'x' }).eq('id', cm.member2).select()).data, []);
  });

  test('7/14. moderators hide comments; hidden comments follow the visibility rules', async () => {
    const { data } = await u.modA.client.from('comments').update({ status: 'hidden' }).eq('id', cm.memberAReply).select('status');
    assert.deepEqual(data, [{ status: 'hidden' }]);
    assert.deepEqual((await u.member2.client.from('comments').select('id').eq('id', cm.memberAReply)).data, []);
    assert.equal((await u.memberA.client.from('comments').select('status').eq('id', cm.memberAReply).single()).data.status, 'hidden');
    const replyToHidden = await u.member2.client.from('comments').insert({ post_id: p.ownerA, parent_comment_id: cm.memberAReply, body: 'x' });
    assert.ok(replyToHidden.error, 'nobody can reply to a hidden comment');
  });

  test('14. an author deletes her own comment; other members no longer see it', async () => {
    const { data } = await u.member2.client.from('comments').update({ status: 'deleted' }).eq('id', cm.member2).select('status');
    assert.deepEqual(data, [{ status: 'deleted' }]);
    assert.deepEqual((await u.memberA.client.from('comments').select('id').eq('id', cm.member2)).data, []);
    const restore = await u.member2.client.from('comments').update({ status: 'published' }).eq('id', cm.member2);
    assert.equal(restore.error?.code, '42501', 'deleted is terminal');
  });
});

describe('reactions', () => {
  test('a member reacts to a post and to a comment', async () => {
    const onPost = await u.memberA.client.from('reactions').insert({ post_id: p.ownerA, reaction_type: 'like' }).select('id, user_id').single();
    assert.equal(onPost.error, null);
    assert.equal(onPost.data.user_id, u.memberA.id);
    p.reaction = onPost.data.id;

    const { data: comment } = await u.ownerA.client.from('comments').insert({ post_id: p.ownerA, body: 'Thanks all' }).select('id').single();
    cm.ownerA = comment.id;
    const onComment = await u.memberA.client.from('reactions').insert({ comment_id: cm.ownerA, reaction_type: 'support' });
    assert.equal(onComment.error, null);
  });

  test('12. reactions cannot be duplicated; changing your reaction updates it', async () => {
    const dup = await u.memberA.client.from('reactions').insert({ post_id: p.ownerA, reaction_type: 'love' });
    assert.equal(dup.error?.code, '23505');
    const { data } = await u.memberA.client.from('reactions').update({ reaction_type: 'love' }).eq('id', p.reaction).select('reaction_type');
    assert.deepEqual(data, [{ reaction_type: 'love' }]);
  });

  test('13. a user cannot manipulate another user\'s reaction (reaction id or user id)', async () => {
    assert.deepEqual((await u.member2.client.from('reactions').update({ reaction_type: 'sad' }).eq('id', p.reaction).select()).data, []);
    assert.deepEqual((await u.member2.client.from('reactions').delete().eq('id', p.reaction).select()).data, []);
    const spoof = await u.member2.client.from('reactions').insert({ post_id: p.memberA, reaction_type: 'like', user_id: u.memberA.id });
    assert.equal(spoof.error?.code, '42501');
    const move = await u.memberA.client.from('reactions').update({ post_id: p.memberA }).eq('id', p.reaction);
    assert.equal(move.error?.code, '42501');
  });

  test('a user cannot react to another community\'s content', async () => {
    assert.equal((await u.memberB.client.from('reactions').insert({ post_id: p.ownerA, reaction_type: 'like' })).error?.code, '42501');
    assert.equal((await u.memberB.client.from('reactions').insert({ comment_id: cm.ownerA, reaction_type: 'like' })).error?.code, '42501');
  });

  test('reaction counts are returned per type, only for visible content', async () => {
    await u.member2.client.from('reactions').insert({ post_id: p.ownerA, reaction_type: 'like' });
    const { data } = await u.memberA.client.rpc('get_reaction_summary', { p_post_ids: [p.ownerA] });
    assert.deepEqual(
      data.map((r) => [r.reaction_type, r.reaction_count, r.reacted_by_me]),
      [['like', 1, false], ['love', 1, true]],
    );
    assert.deepEqual((await u.memberB.client.rpc('get_reaction_summary', { p_post_ids: [p.ownerA] })).data, []);

    const { data: feed } = await u.memberA.client.rpc('list_community_posts', { p_community_id: c.A });
    const row = feed.find((r) => r.id === p.ownerA);
    assert.equal(row.reaction_count, 2);
    assert.equal(row.my_reaction_type, 'love');
  });

  test('a user removes her own reaction', async () => {
    const { data } = await u.memberA.client.from('reactions').delete().eq('id', p.reaction).select('id');
    assert.deepEqual(data, [{ id: p.reaction }]);
  });
});

describe('15. pagination', () => {
  test('the feed pages through every post exactly once with a (created_at, id) cursor', async () => {
    // Inserted in one statement, so they share a created_at timestamp.
    const bodies = Array.from({ length: 23 }, (_, i) => ({ community_id: c.A, body: `Bulk ${i}` }));
    assert.equal((await u.ownerA.client.from('posts').insert(bodies)).error, null);

    const seen = [];
    let cursor = {};
    for (let page = 0; page < 10; page += 1) {
      const { data, error } = await u.member2.client.rpc('list_community_posts', { p_community_id: c.A, p_limit: 10, ...cursor });
      assert.equal(error, null);
      seen.push(...data.map((r) => r.id));
      if (data.length < 10) break;
      const last = data.at(-1);
      cursor = { p_cursor_created_at: last.created_at, p_cursor_id: last.id };
    }
    assert.equal(seen.length, 25, '23 bulk posts + 2 earlier published posts');
    assert.equal(new Set(seen).size, 25, 'no duplicates');
  });

  test('page size is capped at 50 and a half cursor is rejected', async () => {
    const { data } = await u.member2.client.rpc('list_community_posts', { p_community_id: c.A, p_limit: 5000 });
    assert.ok(data.length <= 50);
    const { error } = await u.member2.client.rpc('list_community_posts', { p_community_id: c.A, p_cursor_id: p.ownerA });
    assert.equal(error?.code, '22023');
  });

  test('comments paginate oldest first, with replies loaded per parent', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ post_id: p.ownerA, body: `Comment ${i}` }));
    assert.equal((await u.member2.client.from('comments').insert(rows)).error, null);

    const first = await u.memberA.client.rpc('list_post_comments', { p_post_id: p.ownerA, p_limit: 5 });
    const last = first.data.at(-1);
    const second = await u.memberA.client.rpc('list_post_comments', {
      p_post_id: p.ownerA, p_limit: 5, p_cursor_created_at: last.created_at, p_cursor_id: last.id,
    });
    const ids = [...first.data, ...second.data].map((r) => r.id);
    assert.equal(first.data.length, 5);
    assert.equal(new Set(ids).size, ids.length, 'no duplicates across comment pages');
    // Visible top-level comments for memberA: ownerA's + 7 bulk (member2's original is deleted).
    assert.equal(ids.length, 8);
  });
});

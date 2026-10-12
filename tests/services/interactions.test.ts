// RN-08: comments (threads, pagination, own edits), reactions (types,
// duplicates, summaries) and moderation, against the real local Supabase.
//
//   A: owner (Owner), mod (Moderator), alice, bob (Member)      B: eve (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'mod' | 'alice' | 'bob' | 'eve', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'mod', 'alice', 'bob', 'eve');
  c.A = await community(u.owner, 'InterA');
  c.B = await community(u.eve, 'InterB');
  await addMember(c.A, u.mod.id, 'Moderator');
  await addMember(c.A, u.alice.id, 'Member');
  await addMember(c.A, u.bob.id, 'Member');
  id.post = (await u.alice.services.posts.create({ communityId: c.A, body: 'Thread starter' })).id;
  id.otherPost = (await u.bob.services.posts.create({ communityId: c.A, body: 'Another post' })).id;
  id.postB = (await u.eve.services.posts.create({ communityId: c.B, body: 'In B' })).id;
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('comments', () => {
  test('comments and replies form a thread; the community comes from the post', async () => {
    const top = await u.bob.services.comments.create({ postId: id.post!, body: 'First!' });
    id.top = top.id;
    assert.deepEqual([top.community_id, top.depth, top.author_user_id], [c.A, 0, u.bob.id]);
    const reply = await u.alice.services.comments.create({ postId: id.post!, body: 'Welcome', parentCommentId: top.id });
    id.reply = reply.id;
    assert.equal(reply.depth, 1);
    const nested = await u.bob.services.comments.create({ postId: id.post!, body: 'Thanks', parentCommentId: reply.id });
    assert.equal(nested.depth, 2);

    const tops = await u.alice.services.comments.list({ postId: id.post! });
    assert.deepEqual(tops.items.map((x) => [x.body, x.reply_count]), [['First!', 1]]);
    const replies = await u.alice.services.comments.list({ postId: id.post!, parentCommentId: top.id });
    assert.deepEqual(replies.items.map((x) => x.body), ['Welcome']);
  });

  test('a reply must be to a published comment on the same post', async () => {
    // Refused by the comment trigger without saying whether the parent exists elsewhere.
    const wrongPost = await rejects(u.bob.services.comments.create({ postId: id.otherPost!, body: 'Wrong post', parentCommentId: id.top! }), ErrorCode.Validation);
    assert.match(wrongPost.message, /parent comment not found/i);
    await rejects(u.bob.services.comments.create({ postId: id.post!, body: '' }), ErrorCode.Validation, 'body');
  });

  test('pagination: oldest first, consistent pages', async () => {
    for (let i = 0; i < 5; i += 1) await u.bob.services.comments.create({ postId: id.otherPost!, body: `C${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await u.alice.services.comments.list({ postId: id.otherPost!, limit: 2, cursor });
      seen.push(...page.items.map((x) => x.body));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['C0', 'C1', 'C2', 'C3', 'C4']);
  });

  test('own comments: edit and delete; other people\'s are refused', async () => {
    const edited = await u.bob.services.comments.edit(id.top!, 'First! (edited)');
    assert.ok(edited.edited_at);
    await rejects(u.alice.services.comments.edit(id.top!, 'Hijack'), ErrorCode.Forbidden);
    await rejects(u.mod.services.comments.edit(id.top!, 'Moderators cannot rewrite'), ErrorCode.Forbidden);
    await rejects(u.alice.services.comments.delete(id.top!), ErrorCode.Forbidden);
    const mine = await u.alice.services.comments.create({ postId: id.otherPost!, body: 'Oops' });
    assert.equal((await u.alice.services.comments.delete(mine.id)).status, 'deleted');
    const visible = await u.bob.services.comments.list({ postId: id.otherPost!, limit: 50 });
    assert.ok(!visible.items.some((x) => x.id === mine.id), 'deleted comments leave other members\' threads');
  });
});

describe('moderation', () => {
  test('members cannot moderate; moderators hide and restore posts and comments', async () => {
    await rejects(u.bob.services.posts.hide(id.post!, 'nope'), ErrorCode.Forbidden);
    await rejects(u.bob.services.comments.hide(id.reply!, 'nope'), ErrorCode.Forbidden);

    const hidden = await u.mod.services.comments.hide(id.reply!, 'Rude');
    assert.deepEqual([hidden.status, hidden.moderation_reason], ['hidden', 'Rude']);
    const forBob = await u.bob.services.comments.list({ postId: id.post!, parentCommentId: id.top! });
    assert.deepEqual(forBob.items, [], 'other members no longer see it');
    const forAuthor = await u.alice.services.comments.list({ postId: id.post!, parentCommentId: id.top! });
    assert.equal(forAuthor.items[0]?.status, 'hidden', 'the author sees it as hidden');
    const forMod = await u.mod.services.comments.list({ postId: id.post!, parentCommentId: id.top! });
    assert.equal(forMod.items[0]?.status, 'hidden');
    await rejects(u.bob.services.comments.create({ postId: id.post!, body: 'Reply to hidden', parentCommentId: id.reply! }), ErrorCode.Validation);
    assert.equal((await u.mod.services.comments.restore(id.reply!)).status, 'published');

    assert.equal((await u.mod.services.posts.hide(id.otherPost!, 'Off topic')).status, 'hidden');
    await rejects(u.bob.services.comments.create({ postId: id.otherPost!, body: 'On a hidden post' }), ErrorCode.Forbidden);
    assert.equal((await u.mod.services.posts.restore(id.otherPost!)).status, 'published');
  });
});

describe('reactions', () => {
  test('every supported type; one reaction per user, changing type keeps one', async () => {
    for (const type of ['like', 'love', 'celebrate', 'support', 'laugh', 'sad'] as const) {
      await u.bob.services.posts.react({ postId: id.post!, type });
    }
    const summary = await u.bob.services.posts.reactionSummary({ postIds: [id.post!] });
    assert.deepEqual(summary.map((r) => [r.reaction_type, r.reaction_count, r.reacted_by_me]), [['sad', 1, true]]);
    // @ts-expect-error not a reaction type
    await rejects(u.bob.services.posts.react({ postId: id.post!, type: 'angry' }), ErrorCode.Validation, 'type');
  });

  test('duplicate concurrent reactions never fail and never double count', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => u.alice.services.posts.react({ postId: id.otherPost!, type: 'love' })),
    );
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected')));
    const summary = await u.alice.services.posts.reactionSummary({ postIds: [id.otherPost!] });
    assert.deepEqual(summary.map((r) => [r.reaction_type, r.reaction_count]), [['love', 1]]);
  });

  test('comment reactions, counts per type, and removal', async () => {
    await u.alice.services.posts.react({ commentId: id.top!, type: 'laugh' });
    await u.mod.services.posts.react({ commentId: id.top!, type: 'laugh' });
    await u.owner.services.posts.react({ commentId: id.top!, type: 'support' });
    const summary = await u.alice.services.posts.reactionSummary({ commentIds: [id.top!] });
    assert.deepEqual(summary.map((r) => [r.reaction_type, r.reaction_count, r.reacted_by_me]), [['laugh', 2, true], ['support', 1, false]]);
    await u.alice.services.posts.unreact({ commentId: id.top!});
    const [row] = (await u.alice.services.comments.list({ postId: id.post! })).items;
    assert.deepEqual([row?.reaction_count, row?.my_reaction_type], [2, null]);
  });
});

describe('cross-community protection', () => {
  test('a member of another community can neither read, comment, react nor moderate', async () => {
    assert.deepEqual((await u.eve.services.comments.list({ postId: id.post! })).items, []);
    await rejects(u.eve.services.comments.create({ postId: id.post!, body: 'Intrusion' }), ErrorCode.Forbidden);
    await rejects(u.eve.services.posts.react({ postId: id.post!, type: 'like' }), ErrorCode.Forbidden);
    assert.deepEqual(await u.eve.services.posts.reactionSummary({ postIds: [id.post!], commentIds: [id.top!] }), []);
    await rejects(u.eve.services.posts.hide(id.post!, 'x'), ErrorCode.NotFound);
    await rejects(u.eve.services.comments.hide(id.top!, 'x'), ErrorCode.NotFound);
    // And A's moderator has no power in B.
    await rejects(u.mod.services.posts.hide(id.postB!, 'x'), ErrorCode.NotFound);
  });
});

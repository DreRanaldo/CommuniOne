// What the mobile feed relies on (RN-07), against the real local Supabase,
// beyond the main post flows in content.test.ts: who receives hidden posts
// and moderation reasons, refusals the editor must handle, and isolation.
//
//   A: owner (Owner), mod (Moderator), author, reader (Member)     B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'mod' | 'author' | 'reader' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'mod', 'author', 'reader', 'other');
  c.A = await community(u.owner, 'FeedA');
  c.B = await community(u.other, 'FeedB');
  await addMember(c.A, u.mod.id, 'Moderator');
  await addMember(c.A, u.author.id, 'Member');
  await addMember(c.A, u.reader.id, 'Member');
  id.visible = (await u.author.services.posts.create({ communityId: c.A, body: 'Visible' })).id;
  id.hidden = (await u.author.services.posts.create({ communityId: c.A, body: 'To be hidden' })).id;
  await u.mod.services.posts.hide(id.hidden, 'Off topic');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('feed data', () => {
  test('the author comes from the session; posting into another community is refused', async () => {
    const created = await u.reader.services.posts.create({ communityId: c.A!, body: 'Mine' });
    assert.equal(created.author_user_id, u.reader.id);
    await rejects(u.reader.services.posts.create({ communityId: c.B!, body: 'Intrusion' }), ErrorCode.Forbidden);
    const page = await u.reader.services.posts.list({ communityId: c.B! });
    assert.deepEqual(page.items, [], 'and the other community\'s feed is empty for them');
    await u.reader.services.posts.delete(created.id);
  });

  test('hidden posts and their reasons reach only moderators and the author', async () => {
    const forAuthor = await u.author.services.posts.list({ communityId: c.A!, status: 'hidden' });
    assert.deepEqual(forAuthor.items.map((p) => [p.body, p.moderation_reason]), [['To be hidden', 'Off topic']]);
    const forReader = await u.reader.services.posts.list({ communityId: c.A!, status: 'hidden' });
    assert.deepEqual(forReader.items, [], 'other members get nothing');
    const forMod = await u.mod.services.posts.list({ communityId: c.A!, status: 'hidden' });
    assert.equal(forMod.items.length, 1);
    const published = await u.reader.services.posts.list({ communityId: c.A! });
    assert.ok(published.items.every((p) => p.status === 'published' && p.community_id === c.A));
  });

  test('a hidden post cannot be edited by its author (the editor shows the refusal)', async () => {
    await rejects(u.author.services.posts.edit(id.hidden!, 'Rewritten'), ErrorCode.Forbidden);
  });

  test('deleting someone else\'s post is refused for members; moderators may', async () => {
    await rejects(u.reader.services.posts.delete(id.visible!), ErrorCode.Forbidden);
    const extra = await u.author.services.posts.create({ communityId: c.A!, body: 'Moderated away' });
    assert.equal((await u.mod.services.posts.delete(extra.id)).status, 'deleted');
    const deleted = await u.reader.services.posts.list({ communityId: c.A!, status: 'deleted' });
    assert.ok(deleted.items.length > 0, 'the reader deleted a post of their own earlier');
    assert.ok(
      deleted.items.every((p) => p.author_user_id === u.reader.id),
      'members receive only their own deleted posts, never other people\'s',
    );
  });

  test('my reaction is returned with the post and counted once', async () => {
    await u.reader.services.posts.react({ postId: id.visible!, type: 'like' });
    await u.reader.services.posts.react({ postId: id.visible!, type: 'like' });
    const mine = (await u.reader.services.posts.list({ communityId: c.A! })).items.find((p) => p.id === id.visible);
    assert.deepEqual([mine?.my_reaction_type, mine?.reaction_count], ['like', 1]);
    const theirs = (await u.author.services.posts.list({ communityId: c.A! })).items.find((p) => p.id === id.visible);
    assert.equal(theirs?.my_reaction_type, null, 'another member sees only their own reaction');
    await u.reader.services.posts.unreact({ postId: id.visible! });
    const after = (await u.reader.services.posts.list({ communityId: c.A! })).items.find((p) => p.id === id.visible);
    assert.deepEqual([after?.my_reaction_type, after?.reaction_count], [null, 0]);
  });
});

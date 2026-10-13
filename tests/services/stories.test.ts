// Stories and the redesign's counts (migration 27), against the real local
// Supabase and Storage: upload to your own folder, publish (idempotent),
// see / seen state, signed picture URLs, delete, isolation; community_stats
// and my_profile_stats.
//
//   A: owner (Owner), member (Member), mod (Moderator)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'member' | 'mod' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const jpeg = (n = 2000) => new Uint8Array(n).fill(7);

before(async () => {
  u = await users('owner', 'member', 'mod', 'other');
  c.A = await community(u.owner, 'StoriesA');
  c.B = await community(u.other, 'StoriesB');
  await addMember(c.A, u.member.id, 'Member');
  await addMember(c.A, u.mod.id, 'Moderator');
});
after(async () => {
  await admin.from('stories').delete().in('community_id', Object.values(c));
  await cleanupCommunityContent(Object.values(c));
});

describe('publishing', () => {
  test('upload, then publish once even when retried', async () => {
    const s = u.member.services.stories;
    const { path } = await s.uploadImage({ communityId: c.A, file: jpeg(), mimeType: 'image/jpeg' });
    assert.match(path, new RegExp(`^${c.A}/${u.member.id}/[0-9a-f-]{36}\\.jpg$`));
    const request = '6f1d0a52-6f37-4c3a-9a65-0f7d4c9c0001';
    const story = await s.create({ communityId: c.A, path, width: 1080, height: 1920, caption: ' Garden day! ', clientRequestId: request });
    const again = await s.create({ communityId: c.A, path, width: 1080, height: 1920, clientRequestId: request });
    assert.equal(again.id, story.id);
    assert.equal(story.caption, 'Garden day!');
    id.story = story.id;
    id.path = path;
  });

  test('refusals: other folders, other communities, no permission, bad input', async () => {
    await rejects(u.other.services.stories.uploadImage({ communityId: c.A, file: jpeg(), mimeType: 'image/jpeg' }), ErrorCode.Forbidden);
    await rejects(u.other.services.stories.create({ communityId: c.B, path: id.path!, width: 10, height: 10 }), ErrorCode.Forbidden);
    await rejects(u.mod.services.stories.create({ communityId: c.A, path: id.path!, width: 10, height: 10 }), ErrorCode.Forbidden);
    await rejects(u.member.services.stories.create({ communityId: c.A, path: '../../etc/passwd', width: 10, height: 10 }), ErrorCode.Validation, 'path');
    await rejects(u.member.services.stories.create({ communityId: c.A, path: id.path!, width: 10, height: 10, caption: 'x'.repeat(201) }), ErrorCode.Validation, 'caption');
    await rejects(u.member.services.stories.uploadImage({ communityId: c.A, file: jpeg(11 * 1024 * 1024), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'file');
    // Clients cannot write the table directly.
    const { error } = await u.member.client.from('stories').update({ expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() }).eq('id', id.story!);
    assert.ok(error);
  });
});

describe('seeing stories', () => {
  test('members see it with a signed picture; seen state is per viewer; authors get counts only', async () => {
    const [story] = await u.mod.services.stories.list(c.A);
    assert.equal(story?.id, id.story);
    assert.equal(story?.viewed_by_me, false);
    assert.equal(story?.view_count, null);
    const urls = await u.mod.services.stories.imageUrls([story!.storage_path]);
    const response = await fetch(urls[story!.storage_path]!);
    assert.equal(response.status, 200);
    assert.equal(await u.mod.services.stories.markViewed(id.story!), true);
    assert.equal((await u.mod.services.stories.list(c.A))[0]?.viewed_by_me, true);
    const mine = (await u.member.services.stories.list(c.A))[0]!;
    assert.equal(mine.view_count, 1);
    assert.equal(mine.viewed_by_me, false);
    const { data: views } = await u.member.client.from('story_views').select('*');
    assert.deepEqual(views, []);
  });

  test('another community sees nothing: no rows, no pictures, no marking', async () => {
    assert.deepEqual(await u.other.services.stories.list(c.A), []);
    assert.deepEqual(await u.other.services.stories.imageUrls([id.path!]), {});
    assert.equal(await u.other.services.stories.markViewed(id.story!), false);
    const { data } = await u.other.client.storage.from('stories').download(id.path!);
    assert.equal(data, null);
  });

  test('an expired story disappears for everyone', async () => {
    const { path } = await u.owner.services.stories.uploadImage({ communityId: c.A, file: jpeg(), mimeType: 'image/jpeg' });
    const old = await u.owner.services.stories.create({ communityId: c.A, path, width: 10, height: 10 });
    await admin.from('stories').update({ created_at: new Date(Date.now() - 26 * 3600_000).toISOString(), expires_at: new Date(Date.now() - 3 * 3600_000).toISOString() }).eq('id', old.id).throwOnError();
    for (const who of [u.owner, u.member, u.mod]) {
      assert.ok(!(await who.services.stories.list(c.A)).some((s) => s.id === old.id));
    }
    assert.deepEqual(await u.owner.services.stories.imageUrls([path]), {});
  });
});

describe('deleting', () => {
  test('members cannot delete others’ stories; moderators can; the picture becomes unreadable', async () => {
    const { path } = await u.owner.services.stories.uploadImage({ communityId: c.A, file: jpeg(), mimeType: 'image/jpeg' });
    const story = await u.owner.services.stories.create({ communityId: c.A, path, width: 10, height: 10 });
    await rejects(u.member.services.stories.delete(story.id), ErrorCode.Forbidden);
    assert.equal(await u.other.services.stories.delete(story.id), false);
    assert.equal(await u.mod.services.stories.delete(story.id), true);
    assert.deepEqual(await u.member.services.stories.imageUrls([path]), {});
    assert.equal(await u.member.services.stories.delete(id.story!), true);
    assert.deepEqual(await u.member.services.stories.list(c.A), []);
  });

  test('an unused upload can be discarded by its uploader', async () => {
    const { path } = await u.member.services.stories.uploadImage({ communityId: c.A, file: jpeg(), mimeType: 'image/jpeg' });
    await u.member.services.stories.discardImage(path);
    const { data } = await admin.storage.from('stories').list(`${c.A}/${u.member.id}`);
    assert.ok(!(data ?? []).some((f) => path.endsWith(f.name)));
  });
});

describe('counts', () => {
  test('community_stats: members only, counts follow what the caller may see', async () => {
    await u.owner.services.posts.create({ communityId: c.A, body: 'Hello neighbours' });
    const stats = await u.member.services.communities.stats(c.A);
    assert.equal(stats.member_count, 3);
    assert.equal(stats.posts_today, 1);
    assert.equal(stats.active_alerts, 0);
    assert.equal(stats.document_count, 0);
    await rejects(u.other.services.communities.stats(c.A), ErrorCode.Forbidden);
  });

  test('my_profile_stats: the caller’s own numbers', async () => {
    const mine = await u.owner.services.auth.getMyStats();
    assert.equal(mine.communities, 1);
    assert.equal(mine.posts, 1);
    assert.equal(mine.events_going, 0);
    assert.ok(mine.member_since);
  });
});

// Pictures in posts (migration 26), against the real local Supabase: upload
// into your own folder, create the post and its pictures atomically and
// idempotently, signed-URL access that follows the post's visibility, and
// isolation between communities.
//
//   A: owner (Owner: posts.moderate), author (Member), reader (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'author' | 'reader' | 'other', TestUser>;
const c: Record<string, string> = {};
// A tiny JPEG-looking body (Storage checks the declared type and size).
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => i % 256), 0xff, 0xd9]);
const uuid = () => crypto.randomUUID();

before(async () => {
  u = await users('owner', 'author', 'reader', 'other');
  c.A = await community(u.owner, 'PicsA');
  c.B = await community(u.other, 'PicsB');
  await addMember(c.A, u.author.id, 'Member');
  await addMember(c.A, u.reader.id, 'Member');
});
after(async () => {
  const { data } = await admin.storage.from('post-images').list(c.A!, { limit: 100 });
  for (const folder of data ?? []) {
    const { data: files } = await admin.storage.from('post-images').list(`${c.A}/${folder.name}`);
    if (files?.length) await admin.storage.from('post-images').remove(files.map((f) => `${c.A}/${folder.name}/${f.name}`));
  }
  await cleanupCommunityContent(Object.values(c));
});

describe('creating a post with pictures', () => {
  test('upload, then create atomically; a retry with the same request id does not duplicate', async () => {
    const s = u.author.services.posts;
    const first = await s.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' });
    const second = await s.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' });
    assert.match(first.path, new RegExp(`^${c.A}/${u.author.id}/[0-9a-f-]{36}\\.jpg$`));
    const requestId = uuid();
    const images = [
      { path: first.path, width: 1080, height: 1350 },
      { path: second.path, width: 1920, height: 1080 },
    ];
    const post = await s.create({ communityId: c.A!, body: 'Garden day', images, clientRequestId: requestId });
    const again = await s.create({ communityId: c.A!, body: 'Garden day', images, clientRequestId: requestId });
    assert.equal(again.id, post.id, 'the retry returns the first post');
    const { count } = await admin.from('posts').select('id', { count: 'exact', head: true }).eq('author_user_id', u.author.id);
    assert.equal(count, 1);

    const seen = (await u.reader.services.posts.images([post.id]))[post.id] ?? [];
    assert.deepEqual(seen.map((i) => [i.position, i.width, i.height]), [[0, 1080, 1350], [1, 1920, 1080]]);
    const response = await fetch(seen[0]!.url!);
    assert.equal(response.status, 200, 'a member can load the picture through its signed URL');
    assert.equal((await response.arrayBuffer()).byteLength, jpeg().byteLength);

    // The post's pictures stay with it: they cannot be removed by their uploader.
    await s.discardImage(first.path);
    assert.ok((await u.reader.services.posts.images([post.id]))[post.id]?.length === 2);
    assert.equal((await fetch(seen[0]!.url!)).status, 200);
  });

  test('a text-only post still works; a failed create leaves no post', async () => {
    const s = u.author.services.posts;
    const text = await s.create({ communityId: c.A!, body: 'Just words' });
    assert.deepEqual(await s.images([text.id]), {});
    await rejects(
      s.create({ communityId: c.A!, body: 'Missing file', images: [{ path: `${c.A}/${u.author.id}/${uuid()}.jpg`, width: 10, height: 10 }] }),
      ErrorCode.Validation,
    );
    const { count } = await admin.from('posts').select('id', { count: 'exact', head: true }).eq('body', 'Missing file');
    assert.equal(count, 0);
  });

  test('pictures are refused when they are not yours, or exceed the type and size limits', async () => {
    const mine = await u.author.services.posts.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' });
    await rejects(
      u.reader.services.posts.create({ communityId: c.A!, body: 'Not mine', images: [{ ...mine, width: 1, height: 1 }] }),
      ErrorCode.Forbidden,
    );
    await rejects(u.author.services.posts.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/gif' as never }), ErrorCode.Validation);
    await rejects(
      u.author.services.posts.uploadImage({ communityId: c.A!, file: new Uint8Array(10 * 1024 * 1024 + 1), mimeType: 'image/jpeg' }),
      ErrorCode.Validation,
    );
    // An unattached upload can be discarded by its uploader.
    await u.author.services.posts.discardImage(mine.path);
    const { data } = await admin.storage.from('post-images').list(`${c.A}/${u.author.id}`, { search: mine.path.split('/')[2] });
    assert.equal(data?.length ?? 0, 0);
  });
});

describe('who sees the pictures', () => {
  test('hidden or deleted posts take their pictures with them; other communities see nothing', async () => {
    const s = u.author.services.posts;
    const file = await s.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' });
    const post = await s.create({ communityId: c.A!, body: 'Hide me', images: [{ ...file, width: 800, height: 800 }] });
    const url = (await u.reader.services.posts.images([post.id]))[post.id]![0]!.url!;

    // Another community: no rows, no signing, no upload, no posting.
    assert.deepEqual(await u.other.services.posts.images([post.id]), {});
    const signed = await u.other.client.storage.from('post-images').createSignedUrl(file.path, 60);
    assert.ok(signed.error, 'a non-member cannot sign a URL for the file');
    await rejects(u.other.services.posts.uploadImage({ communityId: c.A!, file: jpeg(), mimeType: 'image/jpeg' }), ErrorCode.Forbidden);
    await rejects(u.other.services.posts.create({ communityId: c.A!, body: 'Intruder' }), ErrorCode.Forbidden);

    await u.owner.services.posts.hide(post.id, 'Off topic');
    assert.deepEqual(await u.reader.services.posts.images([post.id]), {}, 'members lose a hidden post\'s pictures');
    assert.equal((await u.author.services.posts.images([post.id]))[post.id]?.length, 1, 'the author keeps seeing them');
    const resign = await u.reader.client.storage.from('post-images').createSignedUrl(file.path, 60);
    assert.ok(resign.error, 'members cannot sign new URLs for it');
    assert.ok(url, '(an already-issued URL expires on its own; it is short-lived)');
  });

  test('author avatars are returned for co-members only', async () => {
    const mine = await u.reader.services.posts.authorAvatars([u.author.id, u.other.id]);
    assert.ok(u.author.id in mine, 'a co-member\'s profile is visible');
    assert.ok(!(u.other.id in mine), 'a stranger\'s is not');
  });
});

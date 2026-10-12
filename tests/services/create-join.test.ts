// RN-05: creating a community (with logo and cover) and joining one through
// an invitation (preview, then accept), against the real local Supabase
// (Auth, Data API, Storage). Ownership, membership and roles come from the
// existing database functions; nothing is assembled by the client.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, rejects, trackCommunity, users, type TestUser } from './setup.ts';

let u: Record<'creator' | 'member' | 'joiner' | 'late' | 'outsider' | 'suspended', TestUser>;
const c: Record<string, string> = {};
const tokens: Record<string, string> = {};

const image = (size = 256) => new Uint8Array(size).fill(0xff);
const slug = (label: string) => `rn05-${label}-${Date.now().toString(36)}`;

before(async () => {
  u = await users('creator', 'member', 'joiner', 'late', 'outsider', 'suspended');
});
after(async () => {
  if (c.A) {
    const { data } = await admin.storage.from('community-media').list(c.A);
    if (data?.length) await admin.storage.from('community-media').remove(data.map((f) => `${c.A}/${f.name}`));
  }
  await cleanupCommunityContent(Object.values(c));
});

describe('create community', () => {
  test('input is validated before the database', async () => {
    const s = u.creator.services.communities;
    await rejects(s.create({ name: '  ', slug: slug('x') }), ErrorCode.Validation, 'name');
    await rejects(s.create({ name: 'x'.repeat(121), slug: slug('x') }), ErrorCode.Validation, 'name');
    await rejects(s.create({ name: 'Bad slug', slug: 'Not A Slug' }), ErrorCode.Validation, 'slug');
    // @ts-expect-error not a community type
    await rejects(s.create({ name: 'Bad type', slug: slug('x'), type: 'castle' }), ErrorCode.Validation, 'type');
    await rejects(s.create({ name: 'Bad zone', slug: slug('x'), timezone: 'not a zone!' }), ErrorCode.Validation, 'timezone');
    await rejects(s.create({ name: 'Long', slug: slug('x'), description: 'x'.repeat(2001) }), ErrorCode.Validation, 'description');
  });

  test('the database rejects a timezone that does not exist', async () => {
    const error = await rejects(u.creator.services.communities.create({ name: 'Mars', slug: slug('mars'), timezone: 'Mars/Olympus_Mons' }), ErrorCode.Validation);
    assert.match(error.message, /timezone/i);
  });

  test('creating makes the caller its Owner, with an active membership and full authority', async () => {
    const created = await u.creator.services.communities.create({
      name: 'Riverside Commons', slug: slug('riverside'), type: 'residential', description: 'Our neighbourhood.', timezone: 'America/Chicago',
    });
    c.A = created.id;
    trackCommunity(c.A);
    assert.deepEqual([created.name, created.community_type, created.description, created.timezone, created.status],
      ['Riverside Commons', 'residential', 'Our neighbourhood.', 'America/Chicago', 'active']);
    const mine = await u.creator.services.communities.listMine();
    const row = mine.find((m) => m.community_id === c.A);
    assert.equal(row?.membership_status, 'active');
    assert.deepEqual(row?.role_names, ['Owner']);
    const perms = await u.creator.services.communities.myPermissions(c.A);
    for (const key of ['community.update', 'members.invite', 'roles.manage']) assert.ok(perms.includes(key), key);
  });

  test('a duplicate address (slug) is a CONFLICT', async () => {
    const { slug: taken } = await u.creator.services.communities.get(c.A!);
    await rejects(u.outsider.services.communities.create({ name: 'Copy', slug: taken }), ErrorCode.Conflict);
  });
});

describe('community logo and cover image', () => {
  test('the Owner uploads a logo and a cover; they are public files at unguessable paths', async () => {
    const s = u.creator.services.communities;
    await rejects(s.uploadImage(c.A!, 'logo', { file: image(0), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'file');
    await rejects(s.uploadImage(c.A!, 'logo', { file: image(2 * 1024 * 1024 + 1), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'file');
    // @ts-expect-error gif is not allowed
    await rejects(s.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/gif' }), ErrorCode.Validation, 'mimeType');
    // @ts-expect-error not an image kind
    await rejects(s.uploadImage(c.A!, 'banner', { file: image(), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'kind');

    const withLogo = await s.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/png' });
    assert.match(withLogo.logo_path ?? '', new RegExp(`^${c.A}/[0-9a-f-]{36}\\.png$`));
    const withCover = await s.uploadImage(c.A!, 'cover', { file: image(3 * 1024 * 1024), mimeType: 'image/jpeg' });
    assert.match(withCover.cover_image_path ?? '', /\.jpg$/);

    const logoUrl = s.imageUrl(withCover, 'logo');
    assert.ok(logoUrl);
    assert.equal((await fetch(logoUrl)).status, 200, 'served publicly (shown to invitees before they join)');
    const listed = await u.creator.services.communities.listMine();
    assert.equal(listed.find((m) => m.community_id === c.A)?.logo_path, withLogo.logo_path, 'my_communities() returns the logo');
  });

  test('replacing removes the old file; removing clears the community and the file', async () => {
    const s = u.creator.services.communities;
    const before = (await s.get(c.A!)).logo_path;
    const replaced = await s.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/webp' });
    assert.notEqual(replaced.logo_path, before);
    const { data: files } = await admin.storage.from('community-media').list(c.A!);
    assert.equal(files?.some((f) => `${c.A}/${f.name}` === before), false, 'the replaced file is gone');
    const cleared = await s.removeImage(c.A!, 'cover');
    assert.equal(cleared.cover_image_path, null);
    assert.equal(s.imageUrl(cleared, 'cover'), null);
  });

  test('members without community.update and outsiders cannot change the images', async () => {
    await addMember(c.A!, u.member.id, 'Member');
    await rejects(u.member.services.communities.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/jpeg' }), ErrorCode.Forbidden);
    // Outsiders cannot even see the community: NOT_FOUND, as for any community update (no existence leak).
    await rejects(u.outsider.services.communities.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/jpeg' }), ErrorCode.NotFound);
    await rejects(u.member.services.communities.removeImage(c.A!, 'logo'), ErrorCode.Forbidden);
    await rejects(u.outsider.services.communities.removeImage(c.A!, 'logo'), ErrorCode.NotFound);
    assert.ok((await u.creator.services.communities.get(c.A!)).logo_path, 'the logo is unchanged');
  });
});

describe('join with an invitation', () => {
  before(async () => {
    const inv = u.creator.services.invitations;
    tokens.valid = (await inv.create({ communityId: c.A! })).token;
    tokens.single = (await inv.create({ communityId: c.A!, maxUses: 1 })).token;
    const revoked = await inv.create({ communityId: c.A! });
    tokens.revoked = revoked.token;
    await inv.revoke(revoked.invitationId);
    const old = await inv.create({ communityId: c.A! });
    tokens.expired = old.token;
    await admin.from('invitations').update({ status: 'expired' }).eq('id', old.invitationId).throwOnError();
  });

  test('preview: the community is shown, nothing is consumed, nobody joins', async () => {
    const preview = await u.joiner.services.invitations.preview(`communione://join?token=${tokens.valid}`);
    assert.equal(preview.communityId, c.A);
    assert.equal(preview.name, 'Riverside Commons');
    assert.equal(preview.type, 'residential');
    assert.equal(preview.description, 'Our neighbourhood.');
    assert.equal(preview.memberCount, 2);
    assert.equal(preview.membershipStatus, null);
    assert.ok(u.joiner.services.communities.imageUrl(preview, 'logo'), 'the logo is shown before joining');
    const listed = await u.creator.services.invitations.list({ communityId: c.A! });
    assert.ok(listed.every((i) => i.useCount === 0), 'no use consumed');
    assert.deepEqual(await u.joiner.services.communities.listMine(), []);
  });

  test('accept: the user becomes an active Member with Member permissions only', async () => {
    const joined = await u.joiner.services.invitations.redeem(tokens.valid!);
    assert.deepEqual([joined.communityId, joined.status], [c.A, 'active']);
    const row = (await u.joiner.services.communities.listMine()).find((m) => m.community_id === c.A);
    assert.deepEqual(row?.role_names, ['Member']);
    const perms = await u.joiner.services.communities.myPermissions(c.A!);
    assert.ok(perms.includes('posts.create'));
    assert.equal(perms.includes('community.update'), false);
    assert.equal(perms.includes('members.invite'), false);
    await rejects(u.joiner.services.communities.uploadImage(c.A!, 'logo', { file: image(), mimeType: 'image/jpeg' }), ErrorCode.Forbidden);
  });

  test('already a member: the preview says so, and accepting is a CONFLICT that uses nothing', async () => {
    const preview = await u.joiner.services.invitations.preview(tokens.valid!);
    assert.equal(preview.membershipStatus, 'active');
    const error = await rejects(u.joiner.services.invitations.redeem(tokens.valid!), ErrorCode.Conflict);
    assert.match(error.message, /already a member/i);
    const [first] = (await u.creator.services.invitations.list({ communityId: c.A!, includeInactive: true })).filter((i) => i.useCount > 0);
    assert.equal(first?.useCount, 1, 'only the real join was counted');
  });

  test('expired invitations: refused by preview and accept', async () => {
    for (const run of [() => u.late.services.invitations.preview(tokens.expired!), () => u.late.services.invitations.redeem(tokens.expired!)]) {
      const error = await rejects(run(), ErrorCode.Validation);
      assert.match(error.message, /expired/i);
    }
    // Used up: the last use expires it.
    await u.late.services.invitations.redeem(tokens.single!);
    const error = await rejects(u.outsider.services.invitations.preview(tokens.single!), ErrorCode.Validation);
    assert.match(error.message, /expired/i);
  });

  test('revoked invitations: refused by preview and accept', async () => {
    for (const run of [() => u.outsider.services.invitations.preview(tokens.revoked!), () => u.outsider.services.invitations.redeem(tokens.revoked!)]) {
      const error = await rejects(run(), ErrorCode.Validation);
      assert.match(error.message, /revoked/i);
    }
  });

  test('invalid invitations: malformed codes never reach the database; unknown ones reveal nothing', async () => {
    await rejects(u.outsider.services.invitations.preview('hello'), ErrorCode.Validation, 'token');
    await rejects(u.outsider.services.invitations.preview('communione://join?token=nope'), ErrorCode.Validation, 'token');
    const unknown = `ci_${'0'.repeat(64)}`;
    for (const run of [() => u.outsider.services.invitations.preview(unknown), () => u.outsider.services.invitations.redeem(unknown)]) {
      const error = await rejects(run(), ErrorCode.NotFound);
      assert.match(error.message, /invalid invitation/i);
    }
    assert.deepEqual(await u.outsider.services.communities.listMine(), []);
  });

  test('a suspended member is told, and cannot rejoin with an invitation', async () => {
    await addMember(c.A!, u.suspended.id, 'Member', 'suspended');
    const preview = await u.suspended.services.invitations.preview(tokens.valid!);
    assert.equal(preview.membershipStatus, 'suspended');
    await rejects(u.suspended.services.invitations.redeem(tokens.valid!), ErrorCode.Forbidden);
  });

  test('only members.invite holders create invitations', async () => {
    await rejects(u.joiner.services.invitations.create({ communityId: c.A! }), ErrorCode.Forbidden);
    await rejects(u.outsider.services.invitations.create({ communityId: c.A! }), ErrorCode.Forbidden);
  });
});

// What the mobile member directory relies on (RN-14), against the real local
// Supabase: the directory and profiles of one community, name search, paging,
// signed avatars, and that phone numbers, e-mail addresses and members of
// other communities are never returned.
//
//   A: owner (Owner), member (Member), pending (pending membership)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'member' | 'pending' | 'other', TestUser>;
const c: Record<string, string> = {};
const PHONE = '+1 555 0142';

before(async () => {
  u = await users('owner', 'member', 'pending', 'other');
  c.A = await community(u.owner, 'DirA');
  c.B = await community(u.other, 'DirB');
  await addMember(c.A, u.member.id, 'Member');
  await addMember(c.A, u.pending.id, null, 'pending');
  await u.owner.services.auth.updateMyProfile({ displayName: 'Olive Owner', bio: 'Runs the board.' });
  await u.member.services.auth.updateMyProfile({ displayName: 'Milo Member', firstName: 'Milo', lastName: 'Marsh' });
  await u.pending.services.auth.updateMyProfile({ displayName: 'Penny Pending' });
  await u.other.services.auth.updateMyProfile({ displayName: 'Otto Outsider' });
  await u.member.services.auth.setMyPhone(PHONE);
  await u.owner.services.auth.setMyPhone('+1 555 0199');
  // A real uploaded avatar (private bucket): shown through a signed link.
  await u.owner.services.auth.uploadMyAvatar({ file: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), mimeType: 'image/jpeg' });
});
after(async () => {
  // Remove the uploaded avatar too: an orphaned file would show up in other suites' purge checks.
  await u.owner.services.auth.removeMyAvatar();
  await cleanupCommunityContent(Object.values(c));
});

describe('directory', () => {
  test('active members of this community, by name, with roles and a signed avatar', async () => {
    const page = await u.member.services.memberships.directory({ communityId: c.A });
    assert.deepEqual(page.items.map((m) => m.displayName), ['Milo Member', 'Olive Owner']);
    const owner = page.items.find((m) => m.displayName === 'Olive Owner')!;
    assert.deepEqual(owner.roles, ['Owner']);
    assert.equal(owner.isMe, false);
    assert.match(owner.avatarUrl ?? '', /\/storage\/v1\/object\/sign\/avatars\//);
    assert.equal((await fetch(owner.avatarUrl!)).status, 200);
    assert.equal(page.items.find((m) => m.isMe)?.displayName, 'Milo Member');
  });

  test('search is by name, inside this community only', async () => {
    const s = u.member.services.memberships;
    assert.deepEqual((await s.directory({ communityId: c.A, query: 'marsh' })).items.map((m) => m.displayName), ['Milo Member']);
    assert.deepEqual((await s.directory({ communityId: c.A, query: 'Otto' })).items, []);
    assert.deepEqual((await s.directory({ communityId: c.A, query: 'Penny' })).items, []);
    assert.deepEqual((await s.directory({ communityId: c.A, query: '555' })).items, []);
    assert.deepEqual((await s.directory({ communityId: c.A, query: '%' })).items, []);
    await rejects(s.directory({ communityId: c.A, query: 'x'.repeat(101) }), ErrorCode.Validation, 'query');
  });

  test('pages follow the name order', async () => {
    const s = u.member.services.memberships;
    const first = await s.directory({ communityId: c.A, limit: 1 });
    const second = await s.directory({ communityId: c.A, limit: 1, cursor: first.nextCursor });
    assert.deepEqual([...first.items, ...second.items].map((m) => m.displayName), ['Milo Member', 'Olive Owner']);
    // A full page always carries a cursor; the page after the last member is empty.
    assert.deepEqual((await s.directory({ communityId: c.A, limit: 1, cursor: second.nextCursor })).items, []);
  });
});

describe('profile', () => {
  test("a co-member's community profile, without private fields", async () => {
    const owner = await u.member.services.memberships.member(c.A, u.owner.id);
    assert.equal(owner.displayName, 'Olive Owner');
    assert.equal(owner.bio, 'Runs the board.');
    assert.deepEqual(owner.roles, ['Owner']);
    const raw = JSON.stringify(owner);
    assert.doesNotMatch(raw, /555|phone|@|email|status/i);
  });

  test('pending members and members of other communities have no profile here', async () => {
    await rejects(u.member.services.memberships.member(c.A, u.pending.id), ErrorCode.NotFound);
    await rejects(u.member.services.memberships.member(c.A, u.other.id), ErrorCode.NotFound);
  });
});

describe('privacy', () => {
  test('the raw database answers carry no phone or e-mail', async () => {
    const { data } = await u.owner.client.rpc('list_community_members', { p_community_id: c.A });
    const raw = JSON.stringify(data);
    assert.doesNotMatch(raw, /555 0142|phone|example|email/i);
    const { data: one } = await u.owner.client.rpc('get_community_member', { p_community_id: c.A, p_user_id: u.member.id });
    assert.doesNotMatch(JSON.stringify(one), /555 0142|phone|email/i);
  });

  test("phone numbers: even the Owner cannot read a member's", async () => {
    const { data } = await u.owner.client.from('profile_private').select('*').eq('user_id', u.member.id);
    assert.deepEqual(data, []);
    // Embedding through profiles cannot reach them either.
    const { data: embedded, error } = await u.owner.client.from('profiles').select('id, profile_private(phone)').eq('id', u.member.id);
    assert.ok(error || JSON.stringify(embedded).indexOf('0142') === -1);
    assert.equal(await u.member.services.auth.getMyPhone(), PHONE);
  });

  test('community isolation: no directory or profile of a community you are not in', async () => {
    await rejects(u.other.services.memberships.directory({ communityId: c.A }), ErrorCode.Forbidden);
    await rejects(u.other.services.memberships.member(c.A, u.owner.id), ErrorCode.Forbidden);
    await rejects(u.pending.services.memberships.directory({ communityId: c.A }), ErrorCode.Forbidden);
    await rejects(u.member.services.memberships.directory({ communityId: c.B }), ErrorCode.Forbidden);
  });
});

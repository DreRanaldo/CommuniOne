// What the mobile community selector relies on (RN-04), against the real
// local Supabase: my_communities() lists exactly the caller's own pending,
// active and suspended memberships, with roles and statuses; any community id
// outside them gives the caller nothing, whatever the client selects.
//
//   me:   Owner of A, Moderator of B, Member of C (archived),
//         pending in D, suspended in E, left F, rejected in G
//   other: Owner of H (me has no membership)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'me' | 'owner' | 'other', TestUser>;
const c: Record<string, string> = {};

before(async () => {
  u = await users('me', 'owner', 'other');
  c.A = await community(u.me, 'SelectorA');
  for (const key of ['B', 'C', 'D', 'E', 'F', 'G']) c[key] = await community(u.owner, `Selector${key}`);
  c.H = await community(u.other, 'SelectorH');
  await addMember(c.B!, u.me.id, 'Moderator');
  await addMember(c.C!, u.me.id, 'Member');
  await addMember(c.D!, u.me.id, null, 'pending');
  await addMember(c.E!, u.me.id, 'Member', 'suspended');
  await addMember(c.F!, u.me.id, null, 'left');
  await addMember(c.G!, u.me.id, null, 'rejected');
  await admin.from('communities').update({ status: 'archived' }).eq('id', c.C!).throwOnError();
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('community selector data', () => {
  test('lists exactly the caller\'s pending, active and suspended memberships, with roles and statuses', async () => {
    const mine = await u.me.services.communities.listMine();
    const byId = new Map(mine.map((row) => [row.community_id, row]));
    assert.deepEqual(new Set(byId.keys()), new Set([c.A, c.B, c.C, c.D, c.E]), 'left, rejected and foreign communities are not listed');
    assert.deepEqual(byId.get(c.A!)?.role_names, ['Owner']);
    assert.deepEqual(byId.get(c.B!)?.role_names, ['Moderator']);
    assert.equal(byId.get(c.C!)?.community_status, 'archived');
    assert.equal(byId.get(c.D!)?.membership_status, 'pending');
    assert.equal(byId.get(c.E!)?.membership_status, 'suspended');
    for (const row of mine) {
      assert.ok(row.name && row.slug && row.community_type, 'name, slug and type are present for the cards');
    }
  });

  test('every user sees only their own memberships', async () => {
    const theirs = await u.other.services.communities.listMine();
    assert.deepEqual(theirs.map((row) => row.community_id), [c.H]);
  });

  test('selectable communities: full access', async () => {
    for (const id of [c.A!, c.B!]) {
      assert.equal((await u.me.services.communities.get(id)).id, id);
      assert.ok((await u.me.services.communities.myPermissions(id)).includes('community.view'));
    }
  });

  test('a community id outside the caller\'s memberships gives nothing (no existence leak)', async () => {
    await rejects(u.me.services.communities.get(c.H!), ErrorCode.NotFound);
    assert.deepEqual(await u.me.services.communities.myPermissions(c.H!), []);
    assert.deepEqual((await u.me.services.memberships.list({ communityId: c.H! })).items, []);
    // A well-formed id that does not exist answers exactly the same way.
    const missing = 'eeeeeeee-0000-4000-8000-000000000099';
    await rejects(u.me.services.communities.get(missing), ErrorCode.NotFound);
    assert.deepEqual(await u.me.services.communities.myPermissions(missing), []);
  });

  test('pending, suspended and departed memberships carry no permissions', async () => {
    for (const id of [c.D!, c.E!, c.F!, c.G!]) {
      assert.deepEqual(await u.me.services.communities.myPermissions(id), [], `no permissions in ${id}`);
    }
  });

  test('an archived community grants no permissions', async () => {
    assert.deepEqual(await u.me.services.communities.myPermissions(c.C!), []);
  });

  test('a malformed id is rejected before the database', async () => {
    await rejects(u.me.services.communities.get('not-a-uuid'), ErrorCode.Validation, 'communityId');
    await rejects(u.me.services.communities.myPermissions('not-a-uuid'), ErrorCode.Validation, 'communityId');
  });
});

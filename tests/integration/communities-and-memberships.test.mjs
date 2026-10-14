// Stage 3: communities and membership management through the real Data API,
// exactly as the mobile and admin apps will call it.
//
//   Community A                         Community B
//     ownerA   Owner (creator)            ownerB   Owner (creator)
//     adminA   Admin                      memberB  Member
//     modA     Moderator                  ownerA   Member   <- multi-community
//     memberA  Member
//     pendingA  pending, no role
//     pendingA2 pending, no role
//
// Blocks run in order and share state; each block states what it relies on.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember,
  admin,
  createConfirmedUser,
  deleteTrackedUsers,
  roleId,
  signIn,
  trackCommunity,
} from './helpers.mjs';

after(deleteTrackedUsers);

const u = {};       // users: { id, email, client }
const c = {};       // communities: row returned by create_community
const m = {};       // membership ids, e.g. m.memberA

const ownMembership = (user, community) =>
  user.client.from('memberships').select('id, status').eq('community_id', community.id).eq('user_id', user.id);

const setStatus = (actor, membershipId, status) =>
  actor.client.from('memberships').update({ status }).eq('id', membershipId).select('id, status');

const membershipStatus = async (membershipId) =>
  (await admin.from('memberships').select('status').eq('id', membershipId).single()).data?.status;

before(async () => {
  for (const name of ['ownerA', 'adminA', 'modA', 'memberA', 'pendingA', 'pendingA2', 'ownerB', 'memberB']) {
    const user = await createConfirmedUser(name.toLowerCase(), { display_name: name });
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
});

describe('creating communities', () => {
  test('an authenticated user creates a community through create_community()', async () => {
    const { data, error } = await u.ownerA.client.rpc('create_community', {
      p_name: '  Maple Grove HOA ',
      p_slug: `Maple-Grove-${u.ownerA.id.slice(0, 6)}`,
      p_community_type: 'residential',
      p_description: 'Residents of Maple Grove',
      p_timezone: 'America/Chicago',
    });
    assert.equal(error, null);
    trackCommunity(data.id);
    c.A = data;
    assert.equal(data.name, 'Maple Grove HOA');
    assert.equal(data.slug, `maple-grove-${u.ownerA.id.slice(0, 6)}`);
    assert.equal(data.created_by, u.ownerA.id);
    assert.equal(data.status, 'active');

    const { data: b, error: bError } = await u.ownerB.client.rpc('create_community', {
      p_name: 'Grace Church',
      p_slug: `grace-church-${u.ownerB.id.slice(0, 6)}`,
      p_community_type: 'church',
    });
    assert.equal(bError, null);
    trackCommunity(b.id);
    c.B = b;

    // Remaining memberships arrive via trusted backend code (invitations are a later stage).
    m.ownerA = (await ownMembership(u.ownerA, c.A)).data[0].id;
    m.ownerB = (await ownMembership(u.ownerB, c.B)).data[0].id;
    m.adminA = await addMember(c.A.id, u.adminA.id, 'Admin');
    m.modA = await addMember(c.A.id, u.modA.id, 'Moderator');
    m.memberA = await addMember(c.A.id, u.memberA.id, 'Member');
    m.pendingA = await addMember(c.A.id, u.pendingA.id, null, 'pending');
    m.pendingA2 = await addMember(c.A.id, u.pendingA2.id, null, 'pending');
    m.memberB = await addMember(c.B.id, u.memberB.id, 'Member');
    m.ownerAinB = await addMember(c.B.id, u.ownerA.id, 'Member');
  });

  test('invalid input is rejected by database constraints', async () => {
    const attempt = (args) => u.ownerA.client.rpc('create_community', { p_name: 'X', ...args });
    assert.equal((await attempt({ p_slug: c.A.slug })).error?.code, '23505', 'duplicate slug');
    assert.equal((await attempt({ p_slug: 'bad slug!' })).error?.code, '23514', 'slug format');
    assert.equal((await attempt({ p_slug: 'okay-slug-1', p_community_type: 'castle' })).error?.code, '23514', 'community type');
    assert.equal((await attempt({ p_slug: 'okay-slug-2', p_timezone: 'Mars/Base' })).error?.code, '22023', 'timezone');
  });

  test('communities cannot be inserted directly, bypassing the creation recipe', async () => {
    const { error } = await u.ownerA.client.from('communities').insert({ name: 'Direct', slug: 'direct-insert' });
    assert.equal(error?.code, '42501');
  });
});

describe('the creator becomes Owner', () => {
  test('my_communities() shows the creator as an active Owner', async () => {
    const { data, error } = await u.ownerA.client.rpc('my_communities');
    assert.equal(error, null);
    const row = data.find((r) => r.community_id === c.A.id);
    assert.equal(row.membership_status, 'active');
    assert.deepEqual(row.role_names, ['Owner']);
    assert.ok(row.joined_at);
  });

  test('the Owner holds every permission, including roles.manage', async () => {
    const { data } = await u.ownerA.client.rpc('my_community_permissions', { p_community_id: c.A.id });
    assert.equal(data.length, 35); // 31 + 4 marketplace (migration 32)
    assert.ok(data.includes('roles.manage'));
    assert.ok(data.includes('members.remove'));
  });

  test('the new community has the four default system roles', async () => {
    const { data } = await u.ownerA.client.from('roles').select('name, is_system_role').eq('community_id', c.A.id).order('name');
    assert.deepEqual(data, [
      { name: 'Admin', is_system_role: true },
      { name: 'Member', is_system_role: true },
      { name: 'Moderator', is_system_role: true },
      { name: 'Owner', is_system_role: true },
    ]);
  });
});

describe('community retrieval', () => {
  test('a member retrieves the community by slug', async () => {
    const { data, error } = await u.memberA.client.from('communities').select('id, name').eq('slug', c.A.slug).single();
    assert.equal(error, null);
    assert.equal(data.id, c.A.id);
  });

  test('a member lists active members with profiles and roles in one request', async () => {
    const { data, error } = await u.memberA.client
      .from('memberships')
      .select('status, profiles(display_name), membership_roles(roles(name))')
      .eq('community_id', c.A.id);
    assert.equal(error, null);
    const summary = data
      .map((row) => `${row.profiles.display_name}:${row.status}:${row.membership_roles.map((r) => r.roles.name).join('+')}`)
      .sort();
    assert.deepEqual(summary, [
      'adminA:active:Admin',
      'memberA:active:Member',
      'modA:active:Moderator',
      'ownerA:active:Owner',
    ], 'plain members see only active members');
  });

  test('members who manage membership also see pending applications', async () => {
    const { data } = await u.modA.client
      .from('memberships')
      .select('status, profiles(display_name)')
      .eq('community_id', c.A.id)
      .eq('status', 'pending');
    assert.deepEqual(data.map((r) => r.profiles.display_name).sort(), ['pendingA', 'pendingA2']);
  });

  test('a pending member sees only their own membership and not the community', async () => {
    const { data: mine } = await u.pendingA.client.rpc('my_communities');
    assert.deepEqual(mine.map((r) => [r.community_id, r.membership_status]), [[c.A.id, 'pending']]);
    const { data: communities } = await u.pendingA.client.from('communities').select('id');
    assert.deepEqual(communities, []);
  });
});

describe('community updates', () => {
  test('the Owner updates community details and settings', async () => {
    const { data, error } = await u.ownerA.client
      .from('communities')
      .update({ description: 'Updated by owner', settings: { theme: 'green' } })
      .eq('id', c.A.id)
      .select('description, settings');
    assert.equal(error, null);
    assert.deepEqual(data, [{ description: 'Updated by owner', settings: { theme: 'green' } }]);
  });

  test('an Admin (community.update) can update; a Member cannot', async () => {
    const { data: byAdmin } = await u.adminA.client.from('communities').update({ name: 'Maple Grove' }).eq('id', c.A.id).select('name');
    assert.deepEqual(byAdmin, [{ name: 'Maple Grove' }]);

    const { data: byMember, error } = await u.memberA.client.from('communities').update({ name: 'Hijacked' }).eq('id', c.A.id).select();
    assert.equal(error, null);
    assert.deepEqual(byMember, []);
    assert.equal((await admin.from('communities').select('name').eq('id', c.A.id).single()).data.name, 'Maple Grove');
  });

  test('platform-controlled fields (status, slug, created_by) are not client-writable', async () => {
    for (const patch of [{ status: 'archived' }, { slug: 'new-slug' }, { created_by: u.memberA.id }]) {
      const { error } = await u.ownerA.client.from('communities').update(patch).eq('id', c.A.id);
      assert.equal(error?.code, '42501', JSON.stringify(patch));
    }
  });
});

describe('multiple memberships and different roles across communities', () => {
  test('one user is Owner in A and Member in B', async () => {
    const { data } = await u.ownerA.client.rpc('my_communities');
    const byId = Object.fromEntries(data.map((r) => [r.community_id, r.role_names]));
    assert.deepEqual(byId[c.A.id], ['Owner']);
    assert.deepEqual(byId[c.B.id], ['Member']);
  });

  test('permissions differ per community for the same user', async () => {
    const check = async (community, key) =>
      (await u.ownerA.client.rpc('has_community_permission', { p_community_id: community.id, p_permission_key: key })).data;
    assert.equal(await check(c.A, 'members.suspend'), true);
    assert.equal(await check(c.B, 'members.suspend'), false);
    assert.equal(await check(c.B, 'posts.create'), true);

    const { data: inB } = await u.ownerA.client.rpc('my_community_permissions', { p_community_id: c.B.id });
    assert.equal(inB.length, 18); // Member template (+ alerts.create, migration 31; + marketplace view/buy/sell, migration 32)
  });

  test('being Owner in A gives no management power in B', async () => {
    const { data } = await setStatus(u.ownerA, m.memberB, 'suspended');
    assert.deepEqual(data, []);
    assert.equal(await membershipStatus(m.memberB), 'active');
  });
});

describe('unauthorized membership modification is refused', () => {
  test('a Member cannot approve, suspend or remove anyone', async () => {
    assert.deepEqual((await setStatus(u.memberA, m.pendingA, 'active')).data, []);
    assert.deepEqual((await setStatus(u.memberA, m.modA, 'suspended')).data, []);
    const { data: removed } = await u.memberA.client.from('memberships').delete().eq('id', m.modA).select();
    assert.deepEqual(removed, []);
    assert.equal(await membershipStatus(m.pendingA), 'pending');
    assert.equal(await membershipStatus(m.modA), 'active');
  });

  test('a Moderator cannot approve applications (no members.approve)', async () => {
    const { error } = await setStatus(u.modA, m.pendingA, 'active');
    assert.equal(error?.code, '42501');
    assert.equal(await membershipStatus(m.pendingA), 'pending');
  });

  test('a Moderator cannot remove members (no members.remove)', async () => {
    const { data } = await u.modA.client.from('memberships').delete().eq('id', m.memberA).select();
    assert.deepEqual(data, []);
  });

  test('an Admin cannot suspend the Owner (does not hold all the Owner\'s permissions)', async () => {
    const { error } = await setStatus(u.adminA, m.ownerA, 'suspended');
    assert.equal(error?.code, '42501');
    assert.equal(await membershipStatus(m.ownerA), 'active');
  });

  test('a Member cannot grant themselves a role', async () => {
    const { error } = await u.memberA.client
      .from('membership_roles')
      .insert({ membership_id: m.memberA, role_id: await roleId(c.A.id, 'Owner') });
    assert.equal(error?.code, '42501');
  });

  test('nobody can move a membership to another community or user', async () => {
    const { error } = await u.ownerA.client.from('memberships').update({ community_id: c.B.id }).eq('id', m.memberA);
    assert.equal(error?.code, '42501');
  });

  test('memberships cannot be created directly by clients', async () => {
    const { error } = await u.ownerA.client.from('memberships').insert({ community_id: c.A.id, user_id: u.memberB.id, status: 'active' });
    assert.equal(error?.code, '42501');
  });
});

describe('authorized membership management', () => {
  test('the Owner approves a pending application', async () => {
    const { data, error } = await setStatus(u.ownerA, m.pendingA, 'active');
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: m.pendingA, status: 'active' }]);
    const { data: communities } = await u.pendingA.client.from('communities').select('id');
    assert.deepEqual(communities, [{ id: c.A.id }], 'the approved member can now read the community');
  });

  test('the Owner rejects a pending application', async () => {
    const { data } = await setStatus(u.ownerA, m.pendingA2, 'rejected');
    assert.deepEqual(data, [{ id: m.pendingA2, status: 'rejected' }]);
    const { data: mine } = await u.pendingA2.client.rpc('my_communities');
    assert.deepEqual(mine, [], 'a rejected applicant no longer sees the community');
  });

  test('invalid transitions are refused', async () => {
    const { error } = await setStatus(u.ownerA, m.memberA, 'pending');
    assert.equal(error?.code, '22023');
  });
});

describe('cross-community access attempts', () => {
  test('the Owner of B cannot read anything in A, even with A\'s ids', async () => {
    const client = u.ownerB.client;
    assert.deepEqual((await client.from('communities').select('id').eq('id', c.A.id)).data, []);
    assert.deepEqual((await client.from('memberships').select('id').eq('community_id', c.A.id)).data, []);
    assert.deepEqual((await client.from('roles').select('id').eq('community_id', c.A.id)).data, []);
    assert.deepEqual((await client.from('membership_roles').select('id').eq('community_id', c.A.id)).data, []);
    assert.deepEqual((await client.from('profiles').select('id').eq('id', u.memberA.id)).data, []);
    assert.deepEqual((await client.rpc('my_community_permissions', { p_community_id: c.A.id })).data, []);
  });

  test('the Owner of B cannot modify anything in A', async () => {
    const client = u.ownerB.client;
    assert.deepEqual((await client.from('communities').update({ name: 'pwned' }).eq('id', c.A.id).select()).data, []);
    assert.deepEqual((await setStatus(u.ownerB, m.memberA, 'suspended')).data, []);
    assert.deepEqual((await client.from('memberships').delete().eq('id', m.memberA).select()).data, []);
    const { error } = await client.from('membership_roles').insert({ membership_id: m.memberA, role_id: await roleId(c.B.id, 'Owner') });
    assert.equal(error?.code, '42501');
    assert.equal(await membershipStatus(m.memberA), 'active');
  });

  test('a Member of B sees nothing of A in my_communities()', async () => {
    const { data } = await u.memberB.client.rpc('my_communities');
    assert.deepEqual(data.map((r) => r.community_id), [c.B.id]);
  });
});

describe('suspended members', () => {
  test('a Moderator suspends a Member', async () => {
    const { data, error } = await setStatus(u.modA, m.memberA, 'suspended');
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: m.memberA, status: 'suspended' }]);
  });

  test('the suspended member immediately loses access to the community', async () => {
    const client = u.memberA.client;
    assert.deepEqual((await client.from('communities').select('id')).data, []);
    assert.deepEqual((await client.rpc('my_community_permissions', { p_community_id: c.A.id })).data, []);
    const { data: memberships } = await client.from('memberships').select('id, status');
    assert.deepEqual(memberships, [{ id: m.memberA, status: 'suspended' }], 'only their own membership remains visible');
  });

  test('the suspended member can see why (my_communities shows suspended)', async () => {
    const { data } = await u.memberA.client.rpc('my_communities');
    assert.deepEqual(data.map((r) => r.membership_status), ['suspended']);
  });

  test('the suspended member cannot reinstate themselves', async () => {
    const { error } = await setStatus(u.memberA, m.memberA, 'active');
    assert.equal(error?.code, '42501');
    assert.equal(await membershipStatus(m.memberA), 'suspended');
  });

  test('plain members no longer see the suspended member; managers do', async () => {
    const { data: byMember } = await u.pendingA.client.from('memberships').select('id').eq('id', m.memberA);
    assert.deepEqual(byMember, []);
    const { data: byAdmin } = await u.adminA.client.from('memberships').select('id').eq('id', m.memberA);
    assert.equal(byAdmin.length, 1);
  });

  test('reinstating restores access', async () => {
    const { data } = await setStatus(u.modA, m.memberA, 'active');
    assert.deepEqual(data, [{ id: m.memberA, status: 'active' }]);
    const { data: communities } = await u.memberA.client.from('communities').select('id');
    assert.deepEqual(communities, [{ id: c.A.id }]);
  });

  test('the Owner can remove a member entirely', async () => {
    const { data } = await u.ownerA.client.from('memberships').delete().eq('id', m.pendingA).select('id');
    assert.deepEqual(data, [{ id: m.pendingA }]);
    assert.deepEqual((await u.pendingA.client.rpc('my_communities')).data, []);
  });
});

describe('leaving a community', () => {
  test('a member leaves and loses access immediately', async () => {
    const { data, error } = await setStatus(u.memberB, m.memberB, 'left');
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: m.memberB, status: 'left' }]);
    assert.deepEqual((await u.memberB.client.from('communities').select('id')).data, []);
    assert.deepEqual((await u.memberB.client.rpc('my_communities')).data, []);
  });

  test('a member who left cannot re-activate themselves', async () => {
    const { error } = await setStatus(u.memberB, m.memberB, 'active');
    assert.equal(error?.code, '42501');
  });

  test('a suspended member may still leave', async () => {
    await setStatus(u.modA, m.memberA, 'suspended');
    const { data } = await setStatus(u.memberA, m.memberA, 'left');
    assert.deepEqual(data, [{ id: m.memberA, status: 'left' }]);
  });

  test('the last member able to manage roles cannot leave', async () => {
    const { error } = await setStatus(u.ownerB, m.ownerB, 'left');
    assert.equal(error?.code, '42501');
    assert.match(error.message, /last member able to manage roles/);
  });

  test('after handing over ownership, the previous Owner can leave', async () => {
    const { error: grantError } = await u.ownerB.client
      .from('membership_roles')
      .insert({ membership_id: m.ownerAinB, role_id: await roleId(c.B.id, 'Owner') });
    assert.equal(grantError, null);

    const { data } = await setStatus(u.ownerB, m.ownerB, 'left');
    assert.deepEqual(data, [{ id: m.ownerB, status: 'left' }]);

    const { data: perms } = await u.ownerA.client.rpc('my_community_permissions', { p_community_id: c.B.id });
    assert.ok(perms.includes('roles.manage'), 'the new Owner manages B');
  });
});

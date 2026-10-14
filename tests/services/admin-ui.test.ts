// What the mobile admin tools rely on (RN-16), against the real local
// Supabase: member management (approve, suspend, reinstate, remove) with the
// cover rule, role assignment with anti-escalation, invitations (create,
// list without codes, revoke, redeem), alert removal (migration 30),
// moderation views, and isolation between communities.
//
//   A: owner (Owner), admin (Admin), mod (Moderator), member (Member),
//      pending (pending), joiner (no membership; joins by invitation)
//   B: other (Owner), member (Member)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'admin' | 'mod' | 'member' | 'pending' | 'joiner' | 'other', TestUser>;
const c: Record<string, string> = {};
const m: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'admin', 'mod', 'member', 'pending', 'joiner', 'other');
  c.A = await community(u.owner, 'AdminA');
  c.B = await community(u.other, 'AdminB');
  m.admin = await addMember(c.A, u.admin.id, 'Admin');
  m.mod = await addMember(c.A, u.mod.id, 'Moderator');
  m.member = await addMember(c.A, u.member.id, 'Member');
  m.pending = await addMember(c.A, u.pending.id, null, 'pending');
  m.memberB = await addMember(c.B, u.member.id, 'Member');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('member management', () => {
  test('members see active members only; managers also see requests', async () => {
    const asMember = await u.member.services.memberships.list({ communityId: c.A, status: 'pending' });
    assert.deepEqual(asMember.items, [], 'members cannot list requests');
    const asAdmin = await u.admin.services.memberships.list({ communityId: c.A, status: 'pending' });
    assert.deepEqual(asAdmin.items.map((x) => x.id), [m.pending]);
    const one = await u.admin.services.memberships.get(m.pending);
    assert.equal(one.communityId, c.A);
    await rejects(u.member.services.memberships.get(m.pending), ErrorCode.NotFound);
  });

  test('a Moderator cannot approve; an Admin approves (default role assigned)', async () => {
    await rejects(u.mod.services.memberships.approve(m.pending), ErrorCode.Forbidden);
    const approved = await u.admin.services.memberships.approve(m.pending);
    assert.equal(approved.status, 'active');
    assert.deepEqual(approved.roles.map((r) => r.name), ['Member']);
  });

  test('a Moderator suspends a Member but not an Admin (cover rule); reinstates', async () => {
    const suspended = await u.mod.services.memberships.suspend(m.member);
    assert.equal(suspended.status, 'suspended');
    await rejects(u.mod.services.memberships.suspend(m.admin), ErrorCode.Forbidden);
    assert.equal((await u.mod.services.memberships.reinstate(m.member)).status, 'active');
  });

  test('removal needs members.remove and cover; nobody acts on themselves', async () => {
    await rejects(u.mod.services.memberships.remove(m.pending), ErrorCode.Forbidden);
    await rejects(u.admin.services.memberships.suspend(m.admin), ErrorCode.Forbidden);
    const ownerMembership = (await u.owner.services.memberships.getMine(c.A))!.id;
    await rejects(u.admin.services.memberships.suspend(ownerMembership), ErrorCode.Forbidden);
    await rejects(u.admin.services.memberships.remove(ownerMembership), ErrorCode.Forbidden);
    await u.admin.services.memberships.remove(m.pending);
    await rejects(u.admin.services.memberships.get(m.pending), ErrorCode.NotFound);
  });
});

describe('roles', () => {
  test('only roles.manage assigns, never to yourself, never above your own permissions', async () => {
    const roles = await u.owner.services.roles.list(c.A);
    const id = (name: string) => roles.find((r) => r.name === name)!.id;
    await rejects(u.admin.services.roles.assign(m.member, id('Moderator')), ErrorCode.Forbidden);
    await u.owner.services.roles.assign(m.member, id('Moderator'));
    assert.deepEqual((await u.owner.services.memberships.get(m.member)).roles.map((r) => r.name).sort(), ['Member', 'Moderator']);
    await u.owner.services.roles.unassign(m.member, id('Moderator'));
    const ownerMembership = (await u.owner.services.memberships.getMine(c.A))!.id;
    await rejects(u.owner.services.roles.unassign(ownerMembership, id('Owner')), ErrorCode.Forbidden);
  });
});

describe('invitations', () => {
  test('create (code shown once), list without codes, redeem, revoke', async () => {
    await rejects(u.member.services.invitations.create({ communityId: c.A }), ErrorCode.Forbidden);
    await rejects(u.mod.services.invitations.create({ communityId: c.A }), ErrorCode.Forbidden);
    const created = await u.admin.services.invitations.create({ communityId: c.A, expiresIn: '1 day', maxUses: 10 });
    assert.match(created.token, /^ci_[0-9a-f]{64}$/);
    const listed = await u.admin.services.invitations.list({ communityId: c.A });
    const row = listed.find((i) => i.id === created.invitationId)!;
    assert.equal(row.maxUses, 10);
    assert.ok(!JSON.stringify(listed).includes(created.token), 'listings never contain codes');
    assert.deepEqual(await u.member.services.invitations.list({ communityId: c.A }), []);

    await u.joiner.services.invitations.redeem(created.token);
    assert.ok((await u.joiner.services.communities.listMine()).some((x) => x.community_id === c.A));
    assert.equal((await u.admin.services.invitations.list({ communityId: c.A })).find((i) => i.id === created.invitationId)!.useCount, 1);

    await rejects(u.other.services.invitations.revoke(created.invitationId), ErrorCode.NotFound);
    assert.equal(await u.admin.services.invitations.revoke(created.invitationId), true);
    await rejects(u.other.services.invitations.redeem(created.token), ErrorCode.Validation);
  });
});

describe('alerts (migration 30)', () => {
  test('taking a published alert down needs alerts.manage', async () => {
    const alert = await u.admin.services.alerts.create({ communityId: c.A, title: 'Road works', body: 'Main street', severity: 'info', publish: true });
    await rejects(u.member.services.alerts.cancel(alert.id), ErrorCode.Forbidden);
    await rejects(u.mod.services.alerts.expire(alert.id), ErrorCode.Forbidden);
    const cancelled = await u.owner.services.alerts.cancel(alert.id, 'Finished early');
    assert.equal(cancelled.status, 'cancelled');
  });
});

describe('moderation and isolation', () => {
  test('hidden posts reach moderators, not members', async () => {
    const post = await u.member.services.posts.create({ communityId: c.A, body: 'Buy my stuff' });
    await u.mod.services.posts.hide(post.id, 'Spam');
    const other = await u.admin.services.posts.create({ communityId: c.A, body: 'Admin post' });
    await u.mod.services.posts.hide(other.id, 'Test');
    const forMember = await u.member.services.posts.list({ communityId: c.A, status: 'hidden' });
    assert.deepEqual(forMember.items.map((p) => p.id), [post.id], 'members see only their own hidden post');
    const forMod = await u.mod.services.posts.list({ communityId: c.A, status: 'hidden' });
    assert.equal(forMod.items.length, 2);
  });

  test("an Owner of A has no admin power in B, where she has no role", async () => {
    await rejects(u.owner.services.memberships.suspend(m.memberB), ErrorCode.NotFound);
    await rejects(u.owner.services.invitations.create({ communityId: c.B }), ErrorCode.Forbidden);
    assert.deepEqual((await u.owner.services.memberships.list({ communityId: c.B })).items, []);
    await rejects(u.member.services.memberships.suspend(m.memberB), ErrorCode.Forbidden);
  });
});

// Service layer: communities, memberships, roles and invitations.
//
//   Community A: owner (Owner), admin (Admin), mod (Moderator), member (Member)
//   Community B: ownerB (Owner)
//   joiner, pendingUser: join A during the tests
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'admin' | 'mod' | 'member' | 'ownerB' | 'joiner' | 'pendingUser', TestUser>;
const c: Record<string, string> = {};
const m: Record<string, string> = {};

before(async () => {
  u = await users('owner', 'admin', 'mod', 'member', 'ownerB', 'joiner', 'pendingUser');
  c.A = await community(u.owner, 'A');
  c.B = await community(u.ownerB, 'B');
  m.admin = await addMember(c.A, u.admin.id, 'Admin');
  m.mod = await addMember(c.A, u.mod.id, 'Moderator');
  m.member = await addMember(c.A, u.member.id, 'Member');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('communities', () => {
  test('create: the caller becomes Owner', async () => {
    const perms = await u.owner.services.communities.myPermissions(c.A);
    assert.ok(perms.includes('roles.manage'));
    const mine = await u.owner.services.communities.listMine();
    assert.ok(mine.some((row) => row.community_id === c.A && row.role_names.includes('Owner')));
  });

  test('create: input is validated before the database', async () => {
    await rejects(u.owner.services.communities.create({ name: 'X', slug: 'Bad Slug!' }), ErrorCode.Validation, 'slug');
    await rejects(u.owner.services.communities.create({ name: '', slug: 'fine-slug' }), ErrorCode.Validation, 'name');
    // @ts-expect-error status is not settable
    await rejects(u.owner.services.communities.create({ name: 'X', slug: 'fine-slug-2', status: 'active' }), ErrorCode.Validation, 'status');
  });

  test('create: a duplicate slug is a CONFLICT', async () => {
    const existing = await u.owner.services.communities.get(c.A);
    await rejects(u.ownerB.services.communities.create({ name: 'Copy', slug: existing.slug }), ErrorCode.Conflict);
  });

  test('retrieve: members can, outsiders get NOT_FOUND (no existence leak)', async () => {
    assert.equal((await u.member.services.communities.get(c.A)).id, c.A);
    const slug = (await u.owner.services.communities.get(c.A)).slug;
    assert.equal((await u.member.services.communities.getBySlug(slug)).id, c.A);
    await rejects(u.ownerB.services.communities.get(c.A), ErrorCode.NotFound);
    await rejects(u.joiner.services.communities.getBySlug(slug), ErrorCode.NotFound);
  });

  test('update: community.update holders can; members are FORBIDDEN; outsiders NOT_FOUND', async () => {
    const updated = await u.admin.services.communities.update(c.A, { description: 'Updated by admin', settings: { theme: 'green' } });
    assert.equal(updated.description, 'Updated by admin');
    await rejects(u.member.services.communities.update(c.A, { name: 'Hijacked' }), ErrorCode.Forbidden);
    await rejects(u.ownerB.services.communities.update(c.A, { name: 'Hijacked' }), ErrorCode.NotFound);
    // @ts-expect-error slug and status are not editable
    await rejects(u.owner.services.communities.update(c.A, { status: 'suspended' }), ErrorCode.Validation, 'status');
    await rejects(u.owner.services.communities.update(c.A, {}), ErrorCode.Validation, 'patch');
    assert.equal((await u.owner.services.communities.get(c.A)).name, 'Svc A');
  });
});

describe('memberships', () => {
  test('invite member: an admin creates an invitation and a new user redeems it', async () => {
    const invite = await u.admin.services.invitations.create({ communityId: c.A, expiresIn: '2 days', maxUses: 5 });
    assert.match(invite.token, /^ci_[0-9a-f]{64}$/);
    const joined = await u.joiner.services.invitations.redeem(`communione://join?token=${invite.token}`);
    assert.deepEqual([joined.communityId, joined.status], [c.A, 'active']);
    m.joiner = joined.membershipId;
    assert.ok((await u.joiner.services.communities.myPermissions(c.A)).includes('posts.create'));
    const listed = await u.admin.services.invitations.list({ communityId: c.A });
    assert.equal(listed.find((i) => i.id === invite.invitationId)?.useCount, 1);
    assert.ok(!JSON.stringify(listed).includes(invite.token.slice(3)));
  });

  test('invite member: members cannot invite; tokens are validated; redeeming twice is a CONFLICT', async () => {
    await rejects(u.member.services.invitations.create({ communityId: c.A }), ErrorCode.Forbidden);
    await rejects(u.joiner.services.invitations.redeem('ci_123'), ErrorCode.Validation, 'token');
    await rejects(u.joiner.services.invitations.redeem(`ci_${'0'.repeat(64)}`), ErrorCode.NotFound);
    const invite = await u.admin.services.invitations.create({ communityId: c.A });
    await rejects(u.joiner.services.invitations.redeem(invite.token), ErrorCode.Conflict);
    await rejects(u.admin.services.invitations.create({ communityId: c.A, expiresIn: '90 days' }), ErrorCode.Validation);
  });

  test('approve: members.approve holders admit a pending member, who gets the default role', async () => {
    m.pending = await addMember(c.A, u.pendingUser.id, null, 'pending');
    await rejects(u.member.services.memberships.approve(m.pending), ErrorCode.NotFound); // members cannot even see pending rows
    const approved = await u.admin.services.memberships.approve(m.pending);
    assert.equal(approved.status, 'active');
    assert.deepEqual(approved.roles.map((r) => r.name), ['Member']);
  });

  test('list: paginated, with profiles and roles, no duplicates or gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await u.member.services.memberships.list({ communityId: c.A, limit: 2, cursor });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 6); // owner, admin, mod, member, joiner, pendingUser
    const first = (await u.member.services.memberships.list({ communityId: c.A, limit: 1 })).items[0];
    assert.ok(first.roles.some((r) => r.name === 'Owner'));
    assert.deepEqual((await u.ownerB.services.memberships.list({ communityId: c.A })).items, [], 'outsiders see no members');
  });

  test('suspend and reinstate: moderators can; members cannot', async () => {
    await rejects(u.member.services.memberships.suspend(m.joiner), ErrorCode.Forbidden);
    assert.equal((await u.mod.services.memberships.suspend(m.joiner)).status, 'suspended');
    await rejects(u.joiner.services.communities.get(c.A), ErrorCode.NotFound);
    await rejects(u.joiner.services.posts.create({ communityId: c.A, body: 'still here?' }), ErrorCode.Forbidden);
    assert.equal((await u.mod.services.memberships.reinstate(m.joiner)).status, 'active');
  });

  test('anti-escalation: a moderator cannot suspend an admin', async () => {
    await rejects(u.mod.services.memberships.suspend(m.admin), ErrorCode.Forbidden);
  });

  test('remove: members.remove holders can; moderators cannot; outsiders get NOT_FOUND', async () => {
    await rejects(u.mod.services.memberships.remove(m.pending), ErrorCode.Forbidden);
    await rejects(u.ownerB.services.memberships.remove(m.pending), ErrorCode.NotFound);
    await u.admin.services.memberships.remove(m.pending);
    await rejects(u.pendingUser.services.communities.get(c.A), ErrorCode.NotFound);
  });

  test('leave: members leave; the only role manager cannot', async () => {
    await u.joiner.services.memberships.leave(c.A);
    assert.equal((await u.joiner.services.memberships.getMine(c.A))?.status, 'left');
    await rejects(u.owner.services.memberships.leave(c.A), ErrorCode.Forbidden);
  });

  test('roles: owners assign and unassign; nobody escalates themselves', async () => {
    const roles = await u.owner.services.roles.list(c.A);
    const moderator = roles.find((r) => r.name === 'Moderator');
    const ownerRole = roles.find((r) => r.name === 'Owner');
    assert.ok(moderator && ownerRole);
    await u.owner.services.roles.assign(m.member, moderator.id);
    await u.owner.services.roles.unassign(m.member, moderator.id);
    await rejects(u.admin.services.roles.assign(m.admin, ownerRole.id), ErrorCode.Forbidden);
    await rejects(u.member.services.roles.assign(m.member, ownerRole.id), ErrorCode.Forbidden);
    const bRoles = await u.ownerB.services.roles.list(c.B);
    // A role from community B cannot be attached to a membership in A.
    await rejects(u.ownerB.services.roles.assign(m.member, bRoles[0].id), ErrorCode.Forbidden);
    const { data } = await admin.from('membership_roles').select('role_id').eq('membership_id', m.member);
    assert.equal(data?.length, 1, 'the member still has only the Member role');
  });
});

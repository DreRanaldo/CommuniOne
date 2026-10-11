// Pre-Stage 12: invitations (Stage 4) through the real Data API.
//
//   Community A                       Community B
//     ownerA  Owner (members.invite)    ownerB  Owner
//     memberA Member (no members.invite)
//     joiner, crowd[*]: not members anywhere yet
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, anonClient, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

const CROWD = 20;
const LIMIT = 3;

after(async () => {
  for (const id of Object.values(c)) {
    await admin.from('invitation_redemptions').delete().eq('community_id', id);
    await admin.from('invitations').delete().eq('community_id', id);
  }
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const inv = {};

const user = async (label) => {
  const created = await createConfirmedUser(label);
  return { ...created, client: (await signIn(created.email)).client };
};

const createInvitation = async (client, args) => {
  const { data, error } = await client.rpc('create_invitation', args);
  if (error) throw error;
  return data[0];
};

before(async () => {
  for (const name of ['ownerA', 'memberA', 'ownerB', 'joiner']) u[name] = await user(name.toLowerCase());
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Invites ${key}`, p_slug: `invites-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.memberA.id, 'Member');
  u.crowd = await Promise.all(Array.from({ length: CROWD }, (_, i) => user(`crowd${i}`)));
});

describe('creating invitations', () => {
  test('an Owner (members.invite) creates an invitation and receives a one-time token', async () => {
    inv.main = await createInvitation(u.ownerA.client, { p_community_id: c.A });
    assert.match(inv.main.token, /^ci_[0-9a-f]{64}$/);
    assert.ok(new Date(inv.main.expires_at) > new Date());
  });

  test('a member without members.invite cannot create invitations', async () => {
    const { error } = await u.memberA.client.rpc('create_invitation', { p_community_id: c.A });
    assert.equal(error?.code, '42501');
  });

  test('another community\'s Owner cannot create invitations for A', async () => {
    const { error } = await u.ownerB.client.rpc('create_invitation', { p_community_id: c.A });
    assert.equal(error?.code, '42501');
  });

  test('the token is stored only as a hash and the hash is not readable by clients', async () => {
    const { data } = await admin.from('invitations').select('token_hash').eq('id', inv.main.invitation_id).single();
    assert.match(data.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!inv.main.token.includes(data.token_hash));
    const direct = await u.ownerA.client.from('invitations').select('token_hash');
    assert.equal(direct.error?.code, '42501');
    const { data: listed } = await u.ownerA.client.rpc('list_invitations', { p_community_id: c.A });
    assert.equal(listed.length, 1);
    assert.ok(!('token_hash' in listed[0]) && !('token' in listed[0]));
  });

  test('invitations cannot be inserted or edited directly', async () => {
    const insert = await u.ownerA.client.from('invitations').insert({ community_id: c.A, token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 864e5).toISOString() });
    assert.equal(insert.error?.code, '42501');
    const update = await u.ownerA.client.from('invitations').update({ max_uses: 9999 }).eq('id', inv.main.invitation_id);
    assert.equal(update.error?.code, '42501');
  });

  test('members and other communities cannot list A\'s invitations', async () => {
    assert.deepEqual((await u.memberA.client.from('invitations').select('id')).data, []);
    assert.deepEqual((await u.ownerB.client.from('invitations').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await u.ownerB.client.rpc('list_invitations', { p_community_id: c.A })).data, []);
  });
});

describe('redeeming invitations', () => {
  test('signed-out clients cannot redeem', async () => {
    const { error } = await anonClient().rpc('redeem_invitation', { p_token: inv.main.token });
    assert.ok(error);
  });

  test('an unknown token is refused without revealing anything', async () => {
    const { error } = await u.joiner.client.rpc('redeem_invitation', { p_token: `ci_${'0'.repeat(64)}` });
    assert.equal(error?.code, 'P0002');
  });

  test('a valid token makes the user an active member with the default Member role', async () => {
    const { data, error } = await u.joiner.client.rpc('redeem_invitation', { p_token: inv.main.token });
    assert.equal(error, null);
    assert.deepEqual([data[0].community_id, data[0].membership_status], [c.A, 'active']);
    const { data: roles } = await admin.from('membership_roles').select('roles(name)').eq('membership_id', data[0].membership_id);
    assert.deepEqual(roles.map((r) => /** @type {any} */ (r.roles).name), ['Member']);
    const { data: perms } = await u.joiner.client.rpc('my_community_permissions', { p_community_id: c.A });
    assert.ok(perms.length > 0, 'the new member has community permissions immediately');
    assert.ok(!perms.includes('members.invite'));
  });

  test('redeeming twice is refused and does not consume another use', async () => {
    const { error } = await u.joiner.client.rpc('redeem_invitation', { p_token: inv.main.token });
    assert.equal(error?.code, '23505');
    const { data } = await admin.from('invitations').select('use_count').eq('id', inv.main.invitation_id).single();
    assert.equal(data.use_count, 1);
  });

  test('the redemption is audited without the token', async () => {
    const { data } = await u.ownerA.client.rpc('list_audit_logs', { p_community_id: c.A, p_action: 'invitation.redeemed' });
    assert.equal(data.length, 1);
    assert.equal(data[0].actor_user_id, u.joiner.id);
    assert.ok(!JSON.stringify(data[0]).includes(inv.main.token.slice(3)));
  });
});

describe('limits, concurrency and revocation', () => {
  test(`${CROWD} simultaneous redemptions of a ${LIMIT}-use invitation: exactly ${LIMIT} succeed`, async () => {
    inv.limited = await createInvitation(u.ownerA.client, { p_community_id: c.A, p_max_uses: LIMIT });
    const results = await Promise.all(u.crowd.map((m) => m.client.rpc('redeem_invitation', { p_token: inv.limited.token })));
    const ok = results.filter((r) => r.error === null);
    const refused = results.filter((r) => r.error !== null);
    assert.equal(ok.length, LIMIT);
    assert.ok(refused.every((r) => r.error.code === '22023'), JSON.stringify(refused.map((r) => r.error)));

    const { data } = await admin.from('invitations').select('use_count, status').eq('id', inv.limited.invitation_id).single();
    assert.deepEqual(data, { use_count: LIMIT, status: 'expired' });
    const { count } = await admin.from('memberships').select('id', { count: 'exact', head: true })
      .eq('community_id', c.A).in('user_id', u.crowd.map((m) => m.id));
    assert.equal(count, LIMIT, 'no extra memberships were created');
  });

  test('another community\'s Owner cannot revoke A\'s invitation', async () => {
    const { error } = await u.ownerB.client.rpc('revoke_invitation', { p_invitation_id: inv.main.invitation_id });
    assert.equal(error?.code, 'P0002');
  });

  test('a revoked invitation can no longer be redeemed', async () => {
    const { error } = await u.ownerA.client.rpc('revoke_invitation', { p_invitation_id: inv.main.invitation_id });
    assert.equal(error, null);
    const late = await user('late');
    const { error: redeem } = await late.client.rpc('redeem_invitation', { p_token: inv.main.token });
    assert.equal(redeem?.code, '22023');
    assert.match(redeem.message, /revoked/);
  });
});

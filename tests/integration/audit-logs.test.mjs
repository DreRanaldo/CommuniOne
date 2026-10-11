// Stage 11: audit logs through the real Data API.
//
//   Community A                         Community B
//     ownerA  Owner (audit.view)          ownerB  Owner (audit.view)
//     adminA  Admin (audit.view)
//     memberA Member
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

after(deleteTrackedUsers);

const u = {};
const c = {};
const m = {};

const auditFor = async (client, communityId, action) => {
  const { data, error } = await client.rpc('list_audit_logs', { p_community_id: communityId, p_action: action, p_limit: 10 });
  if (error) throw error;
  return data;
};

before(async () => {
  for (const name of ['ownerA', 'adminA', 'memberA', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Audit ${key}`, p_slug: `audit-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  m.adminA = await addMember(c.A, u.adminA.id, 'Admin');
  m.memberA = await addMember(c.A, u.memberA.id, 'Member');
});

describe('recording', () => {
  test('1-3. creating a community is audited with the creator and community', async () => {
    const [entry] = await auditFor(u.ownerA.client, c.A, 'community.created');
    assert.equal(entry.actor_user_id, u.ownerA.id);
    assert.equal(entry.community_id, c.A);
    assert.equal(entry.entity_id, c.A);
  });

  test('1-3. an admin suspending a member is audited with the admin as actor', async () => {
    await u.adminA.client.from('memberships').update({ status: 'suspended' }).eq('id', m.memberA).throwOnError();
    const [entry] = await auditFor(u.ownerA.client, c.A, 'membership.suspended');
    assert.equal(entry.actor_user_id, u.adminA.id);
    assert.equal(entry.community_id, c.A);
    assert.equal(entry.entity_id, m.memberA);
    assert.deepEqual([entry.metadata.user_id, entry.metadata.from, entry.metadata.to], [u.memberA.id, 'active', 'suspended']);
    await u.adminA.client.from('memberships').update({ status: 'active' }).eq('id', m.memberA).throwOnError();
  });

  test('1. role and permission changes are audited', async () => {
    await u.ownerA.client.from('roles').insert({ community_id: c.A, name: 'Auditor' }).throwOnError();
    const { data: role } = await admin.from('roles').select('id').eq('community_id', c.A).eq('name', 'Auditor').single();
    const { data: perm } = await admin.from('permissions').select('id').eq('key', 'audit.view').single();
    await u.ownerA.client.from('role_permissions').insert({ role_id: role.id, permission_id: perm.id }).throwOnError();
    await u.ownerA.client.from('membership_roles').insert({ membership_id: m.memberA, role_id: role.id }).throwOnError();

    assert.equal((await auditFor(u.ownerA.client, c.A, 'role.created'))[0].metadata.name, 'Auditor');
    assert.equal((await auditFor(u.ownerA.client, c.A, 'permission.assigned'))[0].metadata.permission, 'audit.view');
    const [assigned] = await auditFor(u.ownerA.client, c.A, 'role.assigned');
    assert.deepEqual([assigned.metadata.role_name, assigned.metadata.user_id, assigned.actor_user_id], ['Auditor', u.memberA.id, u.ownerA.id]);
  });

  test('the newly granted audit.view takes effect immediately', async () => {
    const { data } = await u.memberA.client.rpc('list_audit_logs', { p_community_id: c.A });
    assert.ok(data.length > 0);
    await u.ownerA.client.from('membership_roles').delete().eq('membership_id', m.memberA)
      .eq('role_id', (await admin.from('roles').select('id').eq('community_id', c.A).eq('name', 'Auditor').single()).data.id)
      .throwOnError();
    assert.equal((await auditFor(u.ownerA.client, c.A, 'role.unassigned')).length, 1);
  });
});

describe('access control', () => {
  test('4. a member without audit.view cannot read audit logs', async () => {
    assert.deepEqual((await u.memberA.client.rpc('list_audit_logs', { p_community_id: c.A })).data, []);
    assert.deepEqual((await u.memberA.client.from('audit_logs').select('id')).data, []);
  });

  test('7. administrators cannot read another community\'s audit log', async () => {
    assert.deepEqual((await u.ownerB.client.rpc('list_audit_logs', { p_community_id: c.A })).data, []);
    assert.deepEqual((await u.ownerB.client.from('audit_logs').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await u.adminA.client.from('audit_logs').select('id').eq('community_id', c.B)).data, []);
    assert.ok((await u.ownerB.client.rpc('list_audit_logs', { p_community_id: c.B })).data.length > 0);
  });

  test('5. nobody can modify or delete audit logs, not even the Owner or the service role', async () => {
    const [entry] = await auditFor(u.ownerA.client, c.A, 'community.created');
    assert.equal((await u.ownerA.client.from('audit_logs').update({ action: 'community.updated' }).eq('id', entry.id)).error?.code, '42501');
    assert.equal((await u.ownerA.client.from('audit_logs').delete().eq('id', entry.id)).error?.code, '42501');
    assert.ok((await admin.from('audit_logs').update({ metadata: {} }).eq('id', entry.id)).error, 'service role update refused');
    assert.ok((await admin.from('audit_logs').delete().eq('id', entry.id)).error, 'service role delete refused');
    const { data } = await admin.from('audit_logs').select('action').eq('id', entry.id).single();
    assert.equal(data.action, 'community.created');
  });

  test('6. clients cannot forge audit entries or actors', async () => {
    const forged = await u.adminA.client.from('audit_logs').insert({
      community_id: c.A, actor_user_id: u.ownerA.id, action: 'membership.removed', entity_type: 'membership',
    });
    assert.equal(forged.error?.code, '42501');
    const viaRpc = await u.ownerA.client.rpc('record_system_audit_event', { p_community_id: c.A, p_action: 'community.updated', p_entity_type: 'community' });
    assert.ok(viaRpc.error, 'clients cannot record system events');
  });
});

describe('8. privacy', () => {
  test('backend system events redact credential-like metadata', async () => {
    const { data: id, error } = await admin.rpc('record_system_audit_event', {
      p_community_id: c.A, p_action: 'community.updated', p_entity_type: 'community', p_entity_id: c.A,
      p_metadata: { password: 'hunter2', access_token: 'eyJabc', nested: { secret: 'x', note: 'kept' }, reason: 'maintenance' },
    });
    assert.equal(error, null);
    const { data } = await admin.from('audit_logs').select('actor_user_id, metadata').eq('id', id).single();
    assert.equal(data.actor_user_id, null, 'system events have no actor');
    assert.deepEqual(data.metadata, { password: '[redacted]', access_token: '[redacted]', nested: { secret: '[redacted]', note: 'kept' }, reason: 'maintenance' });
  });
});

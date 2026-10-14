// Stage 7: alerts through the real Data API.
//
//   Community A                               Community B
//     ownerA   Owner (view/create/manage)       ownerB  Owner
//     adminA   Admin (view/create/manage)
//     alerter  Member + custom "Alerter" role (alerts.view + alerts.create)
//     memberA  Member (alerts.view)
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, roleId, signIn, trackCommunity } from './helpers.mjs';

after(async () => {
  // Alerts block community deletion (communities RESTRICT): remove them first.
  for (const id of Object.values(c)) await admin.from('alerts').delete().eq('community_id', id);
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const al = {};

const alert = async (id) => (await admin.from('alerts').select('*').eq('id', id).single()).data;

before(async () => {
  for (const name of ['ownerA', 'adminA', 'alerter', 'memberA', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Alerts ${key}`,
      p_slug: `alerts-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.adminA.id, 'Admin');
  await addMember(c.A, u.memberA.id, 'Member');
  const alerterMembership = await addMember(c.A, u.alerter.id, 'Member');

  // Owner creates a custom role with alerts.create but not alerts.manage.
  await u.ownerA.client.from('roles').insert({ community_id: c.A, name: 'Alerter' }).throwOnError();
  const alerterRole = await roleId(c.A, 'Alerter');
  const { data: perms } = await admin.from('permissions').select('id').in('key', ['alerts.view', 'alerts.create']);
  await u.ownerA.client.from('role_permissions').insert(perms.map((p) => ({ role_id: alerterRole, permission_id: p.id }))).throwOnError();
  await u.ownerA.client.from('membership_roles').insert({ membership_id: alerterMembership, role_id: alerterRole }).throwOnError();
});

describe('creating and publishing', () => {
  test('1. an authorized user creates a draft alert', async () => {
    const { data, error } = await u.adminA.client
      .from('alerts').insert({ community_id: c.A, title: 'Severe weather', body: 'Storm tonight.', severity: 'warning' })
      .select('id, status, created_by, severity_rank, is_emergency').single();
    assert.equal(error, null);
    assert.deepEqual({ ...data, id: undefined }, { id: undefined, status: 'draft', created_by: u.adminA.id, severity_rank: 2, is_emergency: false });
    al.weather = data.id;
  });

  test('2. a normal member cannot create an alert', async () => {
    const { error } = await u.memberA.client.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y' });
    assert.equal(error?.code, '42501');
  });

  test('3. a normal member cannot create an emergency alert', async () => {
    const { error } = await u.memberA.client.from('alerts').insert({ community_id: c.A, title: 'FIRE', body: 'Evacuate', severity: 'emergency', status: 'published' });
    assert.equal(error?.code, '42501');
  });

  test('3. alerts.create without alerts.manage cannot raise or escalate to an emergency', async () => {
    const direct = await u.alerter.client.from('alerts').insert({ community_id: c.A, title: 'FIRE', body: 'Evacuate', severity: 'emergency' });
    assert.equal(direct.error?.code, '42501');

    const { data } = await u.alerter.client.from('alerts').insert({ community_id: c.A, title: 'Water main', body: 'Low pressure.', severity: 'urgent' }).select('id').single();
    al.water = data.id;
    const escalate = await u.alerter.client.from('alerts').update({ severity: 'emergency' }).eq('id', al.water);
    assert.equal(escalate.error?.code, '42501');
    assert.equal((await alert(al.water)).severity, 'urgent');
  });

  test('3. derived severity fields cannot be supplied by the client', async () => {
    const { error } = await u.adminA.client.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y', severity: 'info', is_emergency: true });
    assert.ok(error);
  });

  test('3. a manager publishes an emergency; it is clearly flagged and listed first', async () => {
    const { data, error } = await u.ownerA.client
      .from('alerts').insert({ community_id: c.A, title: 'Gas leak', body: 'Evacuate building C.', severity: 'emergency', status: 'published' })
      .select('id, is_emergency, severity_rank, published_by').single();
    assert.equal(error, null);
    assert.deepEqual([data.is_emergency, data.severity_rank, data.published_by], [true, 4, u.ownerA.id]);
    al.gas = data.id;
  });

  test('4. publishing: members and non-owners cannot; the author and managers can', async () => {
    assert.deepEqual((await u.memberA.client.from('alerts').update({ status: 'published' }).eq('id', al.weather).select()).data, []);
    assert.deepEqual((await u.alerter.client.from('alerts').update({ status: 'published' }).eq('id', al.weather).select()).data, []);

    const { data } = await u.alerter.client.from('alerts').update({ status: 'published' }).eq('id', al.water).select('status, published_by');
    assert.deepEqual(data, [{ status: 'published', published_by: u.alerter.id }]);
    const { data: weather } = await u.adminA.client.from('alerts').update({ status: 'published' }).eq('id', al.weather).select('status');
    assert.deepEqual(weather, [{ status: 'published' }]);
  });

  test('active alerts: emergencies first; members see them', async () => {
    const { data } = await u.memberA.client.rpc('list_active_alerts', { p_community_id: c.A });
    assert.deepEqual(data.map((r) => r.id), [al.gas, al.water, al.weather]);
    assert.equal(data[0].is_emergency, true);

    const { data: mine } = await u.memberA.client.rpc('list_my_active_alerts');
    assert.equal(mine[0].id, al.gas, 'the app-wide banner leads with the emergency');
  });
});

describe('editing', () => {
  test('5. an author corrects her alert but cannot change its severity once published', async () => {
    const { data } = await u.alerter.client.from('alerts').update({ body: 'Low pressure until 5pm.' }).eq('id', al.water).select('edited_at');
    assert.ok(data[0].edited_at);
    const sev = await u.alerter.client.from('alerts').update({ severity: 'info' }).eq('id', al.water);
    assert.equal(sev.error?.code, '42501');
  });

  test('5. unauthorized users cannot edit or downgrade someone else\'s alert', async () => {
    assert.deepEqual((await u.alerter.client.from('alerts').update({ severity: 'info' }).eq('id', al.gas).select()).data, []);
    assert.deepEqual((await u.memberA.client.from('alerts').update({ title: 'Hacked' }).eq('id', al.gas).select()).data, []);
    assert.equal((await alert(al.gas)).severity, 'emergency');
  });

  test('5. a manager changes severity of a published alert', async () => {
    const { data } = await u.adminA.client.from('alerts').update({ severity: 'urgent' }).eq('id', al.weather).select('severity, updated_by_user_id');
    assert.deepEqual(data, [{ severity: 'urgent', updated_by_user_id: u.adminA.id }]);
  });

  test('10. creator and publisher cannot be forged', async () => {
    const forgedCreator = await u.alerter.client.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y', created_by: u.ownerA.id });
    assert.equal(forgedCreator.error?.code, '42501');
    const forgedPublisher = await u.alerter.client.from('alerts').update({ published_by: u.ownerA.id }).eq('id', al.water);
    assert.equal(forgedPublisher.error?.code, '42501');
  });

  test('10. an alert author cannot grant herself alerts.manage', async () => {
    const { data: manage } = await admin.from('permissions').select('id').eq('key', 'alerts.manage').single();
    const { error } = await u.alerter.client.from('role_permissions').insert({ role_id: await roleId(c.A, 'Alerter'), permission_id: manage.id });
    assert.equal(error?.code, '42501');
  });
});

describe('cancellation and expiry', () => {
  test('6. an author without alerts.manage cannot take her published alert down (migration 30)', async () => {
    const refused = await u.alerter.client
      .from('alerts').update({ status: 'cancelled', cancellation_reason: 'Pressure restored' }).eq('id', al.water);
    assert.equal(refused.error?.code, '42501');
    assert.match(refused.error?.message ?? '', /requires alerts\.manage/);
    assert.equal((await alert(al.water)).status, 'published');
  });

  test('6. an alert manager cancels it with a reason', async () => {
    const { data, error } = await u.adminA.client
      .from('alerts').update({ status: 'cancelled', cancellation_reason: 'Pressure restored' }).eq('id', al.water)
      .select('status, cancelled_by, cancellation_reason');
    assert.equal(error, null);
    assert.deepEqual(data, [{ status: 'cancelled', cancelled_by: u.adminA.id, cancellation_reason: 'Pressure restored' }]);
    const { data: history } = await u.memberA.client.rpc('list_alert_history', { p_community_id: c.A });
    assert.equal(history.find((r) => r.id === al.water)?.status, 'cancelled');
  });

  test('6. members cannot cancel alerts', async () => {
    assert.deepEqual((await u.memberA.client.from('alerts').update({ status: 'cancelled' }).eq('id', al.gas).select()).data, []);
  });

  test('7. a manager ends an alert early', async () => {
    const { data } = await u.adminA.client.from('alerts').update({ status: 'expired' }).eq('id', al.weather).select('status, expired_at');
    assert.equal(data[0].status, 'expired');
    assert.ok(data[0].expired_at);
  });

  test('7. an alert past expires_at stops being active; the service-role sweep records it', async () => {
    const { data } = await u.ownerA.client.from('alerts').insert({
      community_id: c.A, title: 'Road works', body: 'Main St.', severity: 'info', status: 'published',
      expires_at: new Date(Date.now() + 1500).toISOString(),
    }).select('id').single();
    al.road = data.id;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const { data: active } = await u.memberA.client.rpc('list_active_alerts', { p_community_id: c.A });
    assert.ok(!active.some((r) => r.id === al.road), 'not active once expired, even before the sweep');

    const { error: clientSweep } = await u.ownerA.client.rpc('expire_due_alerts');
    assert.equal(clientSweep?.code, '42501', 'clients cannot run the sweep');

    const { data: swept, error } = await admin.rpc('expire_due_alerts');
    assert.equal(error, null);
    assert.ok(swept >= 1);
    assert.equal((await alert(al.road)).status, 'expired');
    const { data: events } = await admin.from('alert_events').select('event_type, actor_user_id').eq('alert_id', al.road).order('occurred_at');
    assert.deepEqual(events, [
      { event_type: 'published', actor_user_id: u.ownerA.id },
      { event_type: 'expired', actor_user_id: null },
    ]);
  });
});

describe('isolation, RLS and the notification outbox', () => {
  test('8. another community cannot read or act on these alerts', async () => {
    const client = u.ownerB.client;
    assert.deepEqual((await client.from('alerts').select('id').eq('id', al.gas)).data, []);
    assert.deepEqual((await client.from('alerts').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await client.rpc('list_active_alerts', { p_community_id: c.A })).data, []);
    assert.deepEqual((await client.rpc('list_alert_history', { p_community_id: c.A })).data, []);
    assert.deepEqual((await client.rpc('list_my_active_alerts')).data, []);
    assert.deepEqual((await client.from('alerts').update({ status: 'cancelled' }).eq('id', al.gas).select()).data, []);
    const intoA = await client.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y', severity: 'emergency' });
    assert.equal(intoA.error?.code, '42501');
  });

  test('9. the event log is visible to managers only and never writable by clients', async () => {
    const { data: managerView } = await u.adminA.client.from('alert_events').select('event_type').eq('alert_id', al.gas);
    assert.deepEqual(managerView, [{ event_type: 'published' }]);
    assert.deepEqual((await u.memberA.client.from('alert_events').select('id')).data, []);
    const forge = await u.ownerA.client.from('alert_events').insert({ alert_id: al.gas, community_id: c.A, event_type: 'published', severity: 'emergency' });
    assert.equal(forge.error?.code, '42501');
  });

  test('9. alerts cannot be deleted by clients', async () => {
    assert.equal((await u.ownerA.client.from('alerts').delete().eq('id', al.gas)).error?.code, '42501');
  });

  test('deleting an alert creator\'s account keeps their alerts, attributed to a deleted user', async () => {
    const before = await alert(al.water);
    assert.equal(before.created_by, u.alerter.id);
    const memberView = async () => (await u.memberA.client.from('alerts').select('id, title, status').eq('id', al.water)).data;
    const seenBefore = await memberView();
    const { error } = await u.alerter.client.rpc('delete_my_account');
    assert.equal(error, null);
    const after = await alert(al.water);
    assert.equal(after.created_by, null, 'creator is cleared (shown as "Deleted User")');
    assert.deepEqual([after.title, after.status], [before.title, before.status]);
    assert.deepEqual(await memberView(), seenBefore, 'members see the alert exactly as before');
  });
});

// Stage 6: announcements through the real Data API.
//
//   Community A                         Community B
//     ownerA  Owner (create + manage)     ownerB  Owner
//     adminA  Admin (create + manage)
//     memberA Member (view only)
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

after(async () => {
  for (const id of Object.values(c)) await admin.from('announcements').delete().eq('community_id', id);
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const a = {};

const statusOf = async (id) => (await admin.from('announcements').select('status').eq('id', id).single()).data?.status;

before(async () => {
  for (const name of ['ownerA', 'adminA', 'memberA', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Announce ${key}`,
      p_slug: `announce-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.adminA.id, 'Admin');
  await addMember(c.A, u.memberA.id, 'Member');
});

describe('creating and publishing', () => {
  test('1. an authorized user creates a draft announcement', async () => {
    const { data, error } = await u.adminA.client
      .from('announcements')
      .insert({ community_id: c.A, title: 'Annual meeting', body: 'Join us on the 20th.' })
      .select('id, status, author_user_id, published_at')
      .single();
    assert.equal(error, null);
    assert.equal(data.status, 'draft');
    assert.equal(data.author_user_id, u.adminA.id);
    assert.equal(data.published_at, null);
    a.meeting = data.id;
  });

  test('2. a normal member cannot create an announcement', async () => {
    const { error } = await u.memberA.client.from('announcements').insert({ community_id: c.A, title: 'Hi', body: 'From a member' });
    assert.equal(error?.code, '42501');
  });

  test('10. changing the community id does not bypass RLS', async () => {
    const intoB = await u.adminA.client.from('announcements').insert({ community_id: c.B, title: 'x', body: 'Admin of A into B' });
    assert.equal(intoB.error?.code, '42501');
    const move = await u.adminA.client.from('announcements').update({ community_id: c.B }).eq('id', a.meeting);
    assert.equal(move.error?.code, '42501');
  });

  test('7. a draft is invisible to normal members', async () => {
    assert.deepEqual((await u.memberA.client.from('announcements').select('id').eq('id', a.meeting)).data, []);
    assert.deepEqual((await u.memberA.client.rpc('list_current_announcements', { p_community_id: c.A })).data, []);
  });

  test('3. an authorized user publishes the announcement', async () => {
    const { data, error } = await u.adminA.client
      .from('announcements').update({ status: 'published' }).eq('id', a.meeting).select('status, published_at');
    assert.equal(error, null);
    assert.equal(data[0].status, 'published');
    assert.ok(data[0].published_at);
  });

  test('priority: an important announcement is created and listed first', async () => {
    const { data } = await u.ownerA.client
      .from('announcements')
      .insert({ community_id: c.A, title: 'Boil water notice', body: 'Boil tap water until further notice.', priority: 'important', status: 'published' })
      .select('id').single();
    a.boil = data.id;
    const { data: current } = await u.memberA.client.rpc('list_current_announcements', { p_community_id: c.A });
    assert.deepEqual(current.map((r) => r.id), [a.boil, a.meeting]);
  });
});

describe('reading', () => {
  test('6. a member reads published announcements, current and by id', async () => {
    const { data, error } = await u.memberA.client.from('announcements').select('title, priority').eq('id', a.boil).single();
    assert.equal(error, null);
    assert.deepEqual(data, { title: 'Boil water notice', priority: 'important' });
  });

  test('9. users from another community cannot read them', async () => {
    assert.deepEqual((await u.ownerB.client.from('announcements').select('id').eq('id', a.boil)).data, []);
    assert.deepEqual((await u.ownerB.client.from('announcements').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await u.ownerB.client.rpc('list_current_announcements', { p_community_id: c.A })).data, []);
    assert.deepEqual((await u.ownerB.client.rpc('list_announcement_history', { p_community_id: c.A })).data, []);
  });
});

describe('editing and managing', () => {
  test('4. the author edits a published announcement (marked as edited)', async () => {
    const { data } = await u.adminA.client
      .from('announcements').update({ body: 'Join us on the 21st (new date).' }).eq('id', a.meeting).select('body, edited_at');
    assert.equal(data[0].body, 'Join us on the 21st (new date).');
    assert.ok(data[0].edited_at);
  });

  test('4. a manager edits another author\'s announcement', async () => {
    const { data } = await u.ownerA.client.from('announcements').update({ title: 'Annual general meeting' }).eq('id', a.meeting).select('title, updated_by_user_id');
    assert.deepEqual(data, [{ title: 'Annual general meeting', updated_by_user_id: u.ownerA.id }]);
  });

  test('5. unauthorized users cannot modify, archive or delete announcements', async () => {
    assert.deepEqual((await u.memberA.client.from('announcements').update({ title: 'Hacked' }).eq('id', a.boil).select()).data, []);
    assert.deepEqual((await u.memberA.client.from('announcements').update({ status: 'archived' }).eq('id', a.boil).select()).data, []);
    assert.deepEqual((await u.ownerB.client.from('announcements').update({ status: 'deleted' }).eq('id', a.boil).select()).data, []);
    assert.equal((await u.adminA.client.from('announcements').delete().eq('id', a.boil)).error?.code, '42501', 'no hard delete');
    assert.equal(await statusOf(a.boil), 'published');
  });

  test('protected columns cannot be written', async () => {
    for (const patch of [{ published_at: '2000-01-01T00:00:00Z' }, { author_user_id: u.memberA.id }]) {
      const { error } = await u.ownerA.client.from('announcements').update(patch).eq('id', a.boil);
      assert.equal(error?.code, '42501', JSON.stringify(patch));
    }
  });

  test('archive moves an announcement from current to history; it can be republished', async () => {
    await u.adminA.client.from('announcements').update({ status: 'archived' }).eq('id', a.meeting).throwOnError();
    const { data: current } = await u.memberA.client.rpc('list_current_announcements', { p_community_id: c.A });
    assert.deepEqual(current.map((r) => r.id), [a.boil]);
    const { data: history } = await u.memberA.client.rpc('list_announcement_history', { p_community_id: c.A });
    assert.deepEqual(history.map((r) => [r.id, r.status]).sort(), [[a.boil, 'published'], [a.meeting, 'archived']].sort());

    const { data } = await u.adminA.client.from('announcements').update({ status: 'published' }).eq('id', a.meeting).select('status, archived_at');
    assert.deepEqual(data, [{ status: 'published', archived_at: null }]);
  });

  test('soft delete is terminal and hides the announcement from members', async () => {
    const { data } = await u.adminA.client.from('announcements').update({ status: 'deleted' }).eq('id', a.meeting).select('status');
    assert.deepEqual(data, [{ status: 'deleted' }]);
    assert.deepEqual((await u.memberA.client.from('announcements').select('id').eq('id', a.meeting)).data, []);
    const restore = await u.adminA.client.from('announcements').update({ status: 'published' }).eq('id', a.meeting);
    assert.equal(restore.error?.code, '42501');
    const { data: managerView } = await u.ownerA.client.rpc('list_announcement_history', { p_community_id: c.A, p_statuses: ['deleted'] });
    assert.deepEqual(managerView.map((r) => r.id), [a.meeting], 'managers can review deleted announcements');
  });
});

describe('8. expiration', () => {
  test('an announcement cannot be published already expired', async () => {
    const { error } = await u.adminA.client.from('announcements').insert({
      community_id: c.A, title: 'Old news', body: 'x', status: 'published', expires_at: '2000-01-01T00:00:00Z',
    });
    assert.equal(error?.code, '22023');
  });

  test('once expired, an announcement leaves the current list but stays in history', async () => {
    const { data } = await u.adminA.client.from('announcements').insert({
      community_id: c.A, title: 'Road closure', body: 'Main St closed today.', status: 'published',
      expires_at: new Date(Date.now() + 2000).toISOString(),
    }).select('id').single();
    a.road = data.id;

    const before = await u.memberA.client.rpc('list_current_announcements', { p_community_id: c.A });
    assert.ok(before.data.some((r) => r.id === a.road), 'current before expiry');

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const after = await u.memberA.client.rpc('list_current_announcements', { p_community_id: c.A });
    assert.ok(!after.data.some((r) => r.id === a.road), 'not current after expiry');
    const { data: history } = await u.memberA.client.rpc('list_announcement_history', { p_community_id: c.A });
    assert.equal(history.find((r) => r.id === a.road)?.is_expired, true, 'in history, flagged expired');
    assert.equal(await statusOf(a.road), 'published', 'status is unchanged; expiry is time-based');
  });
});

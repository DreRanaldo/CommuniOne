// Stage 9: notifications through the real Data API.
//
//   Community A                              Community B
//     ownerA  Owner                            ownerB  Owner
//     memberA Member
//     member2 Member
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

after(async () => {
  for (const id of Object.values(c)) {
    await admin.from('announcements').delete().eq('community_id', id);
    await admin.from('comments').delete().eq('community_id', id);
    await admin.from('posts').delete().eq('community_id', id);
  }
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const n = {};
const m = {};

before(async () => {
  for (const name of ['ownerA', 'memberA', 'member2', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Notify ${key}`,
      p_slug: `notify-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  m.memberA = await addMember(c.A, u.memberA.id, 'Member');
  await addMember(c.A, u.member2.id, 'Member');
});

describe('receiving and reading', () => {
  test('1. members receive a notification when an announcement is published', async () => {
    await u.ownerA.client.from('announcements')
      .insert({ community_id: c.A, title: 'Board meeting', body: 'Thursday 7pm', status: 'published' }).throwOnError();

    const { data, error } = await u.memberA.client.rpc('list_my_notifications');
    assert.equal(error, null);
    assert.equal(data.length, 1);
    assert.deepEqual([data[0].type, data[0].community_id, data[0].title], ['announcement', c.A, 'Board meeting']);
    n.memberA = data[0].id;

    assert.deepEqual((await u.ownerA.client.rpc('list_my_notifications')).data, [], 'the author is not notified');
    assert.deepEqual((await u.ownerB.client.rpc('list_my_notifications')).data, [], 'other communities are not notified');
  });

  test('6. unread count', async () => {
    const { data } = await u.memberA.client.rpc('unread_notification_count');
    assert.equal(data, 1);
  });

  test('3. a user cannot read another user\'s notifications', async () => {
    assert.deepEqual((await u.member2.client.from('notifications').select('id').eq('id', n.memberA)).data, []);
    assert.deepEqual((await u.ownerA.client.from('notifications').select('id').eq('user_id', u.memberA.id)).data, []);
    assert.deepEqual((await u.ownerB.client.from('notifications').select('id').eq('id', n.memberA)).data, []);
  });

  test('4. a user marks her notification read and unread', async () => {
    assert.equal((await u.memberA.client.rpc('mark_notification_read', { p_notification_id: n.memberA })).data, true);
    assert.equal((await u.memberA.client.rpc('unread_notification_count')).data, 0);
    assert.equal((await u.memberA.client.rpc('mark_notification_unread', { p_notification_id: n.memberA })).data, true);
    assert.equal((await u.memberA.client.rpc('mark_all_notifications_read')).data, 1);
  });

  test('5. a user cannot modify, delete or rewrite another user\'s notification', async () => {
    assert.equal((await u.member2.client.rpc('mark_notification_unread', { p_notification_id: n.memberA })).data, false);
    assert.deepEqual((await u.member2.client.from('notifications').update({ archived_at: new Date().toISOString() }).eq('id', n.memberA).select()).data, []);
    assert.deepEqual((await u.member2.client.from('notifications').delete().eq('id', n.memberA).select()).data, []);
    const rewrite = await u.memberA.client.from('notifications').update({ title: 'Edited' }).eq('id', n.memberA);
    assert.equal(rewrite.error?.code, '42501', 'content is immutable even for the owner');
    const { data } = await admin.from('notifications').select('title, archived_at').eq('id', n.memberA).single();
    assert.deepEqual(data, { title: 'Board meeting', archived_at: null });
  });
});

describe('8. creation is server-controlled', () => {
  test('clients cannot insert notifications or call the service', async () => {
    const insert = await u.memberA.client.from('notifications').insert({ user_id: u.member2.id, type: 'system', title: 'You won!' });
    assert.equal(insert.error?.code, '42501');
    const rpc = await u.ownerA.client.rpc('create_notification', { p_user_id: u.member2.id, p_community_id: null, p_type: 'system', p_title: 'Spam' });
    assert.ok(rpc.error, 'even a community Owner cannot send arbitrary notifications');
  });

  test('trusted backend code (service role) creates notifications, idempotently', async () => {
    const args = { p_user_id: u.member2.id, p_community_id: null, p_type: 'system', p_title: 'Welcome', p_dedupe_key: 'welcome' };
    const first = await admin.rpc('create_notification', args);
    assert.equal(first.error, null);
    assert.ok(first.data);
    const second = await admin.rpc('create_notification', args);
    assert.equal(second.data, null, 'deduplicated');
  });

  test('10. the service refuses community notifications for non-members', async () => {
    const { error } = await admin.rpc('create_notification', {
      p_user_id: u.ownerB.id, p_community_id: c.A, p_type: 'announcement', p_title: 'Leak',
    });
    assert.match(error?.message ?? '', /not an active member/);
  });
});

describe('9/10. community association and isolation', () => {
  test('comment notifications go to the post author, scoped to the community', async () => {
    const { data: post } = await u.memberA.client.from('posts').insert({ community_id: c.A, body: 'Lost cat' }).select('id').single();
    await u.member2.client.from('comments').insert({ post_id: post.id, body: 'Seen her by the pond' }).throwOnError();
    const { data } = await u.memberA.client.rpc('list_my_notifications', { p_unread_only: true });
    const comment = data.find((row) => row.type === 'comment');
    assert.equal(comment.community_id, c.A);
    assert.equal(comment.data.post_id, post.id);
  });

  test('7. pagination returns each notification exactly once', async () => {
    for (let i = 0; i < 12; i += 1) {
      await admin.rpc('create_notification', { p_user_id: u.memberA.id, p_community_id: null, p_type: 'system', p_title: `Notice ${i}` }).throwOnError();
    }
    const seen = [];
    let cursor = {};
    for (let page = 0; page < 10; page += 1) {
      const { data } = await u.memberA.client.rpc('list_my_notifications', { p_limit: 5, ...cursor });
      seen.push(...data.map((row) => row.id));
      if (data.length < 5) break;
      cursor = { p_cursor_created_at: data.at(-1).created_at, p_cursor_id: data.at(-1).id };
    }
    const { count } = await admin.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', u.memberA.id);
    assert.equal(seen.length, count);
    assert.equal(new Set(seen).size, count);
  });

  test('10. removed members lose access to community notifications but are told about the removal', async () => {
    await u.ownerA.client.from('memberships').update({ status: 'suspended' }).eq('id', m.memberA).throwOnError();
    const { data } = await u.memberA.client.rpc('list_my_notifications', { p_limit: 100 });
    const communityTypes = [...new Set(data.filter((row) => row.community_id).map((row) => row.type))];
    assert.deepEqual(communityTypes, ['membership'], 'only the suspension notice remains readable');
    assert.ok(data.some((row) => row.type === 'system'), 'account notifications remain');
    assert.deepEqual((await u.memberA.client.from('notifications').select('id').eq('id', n.memberA)).data, []);
  });
});

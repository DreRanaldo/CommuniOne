// What the mobile notification center relies on (RN-12), against the real
// local Supabase: notifications produced by real actions carry routing ids;
// paging, unread counts and read state; only the owner sees or changes them;
// a destination is still authorized by the backend when opened.
//
//   A: owner (Owner), member (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'member' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  u = await users('owner', 'member', 'other');
  c.A = await community(u.owner, 'NotifA');
  c.B = await community(u.other, 'NotifB');
  await addMember(c.A, u.member.id, 'Member');
  // Real producers: each of these notifies the member.
  id.announcement = (await u.owner.services.announcements.create({ communityId: c.A, title: 'Pool opens', body: 'Saturday', publish: true })).id;
  id.alert = (await u.owner.services.alerts.create({ communityId: c.A, title: 'Gas leak', body: 'Leave now', severity: 'urgent', publish: true })).id;
  id.event = (await u.owner.services.events.create({ communityId: c.A, title: 'Picnic', startsAt: inHours(24), endsAt: inHours(26), publish: true })).id;
  id.post = (await u.member.services.posts.create({ communityId: c.A, body: 'Who has a ladder?' })).id;
  await u.owner.services.comments.create({ postId: id.post, body: 'I do!' });
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('the inbox', () => {
  test('newest first, each with the id of what it is about; pages follow the cursor', async () => {
    const s = u.member.services.notifications;
    const all = (await s.list({ limit: 50 })).items;
    assert.deepEqual(all.map((n) => n.type), ['comment', 'event_created', 'alert', 'announcement']);
    const data = (type: string) => all.find((n) => n.type === type)!.data as Record<string, string>;
    assert.equal(data('announcement').announcement_id, id.announcement);
    assert.equal(data('alert').alert_id, id.alert);
    assert.equal(data('event_created').event_id, id.event);
    assert.equal(data('comment').post_id, id.post);
    assert.ok(all.every((n) => n.community_id === c.A));

    const first = await s.list({ limit: 2 });
    const second = await s.list({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual([...first.items, ...second.items].map((n) => n.id), all.map((n) => n.id));
  });

  test('unread count, mark read and unread, mark all read', async () => {
    const s = u.member.services.notifications;
    assert.equal(await s.unreadCount(), 4);
    const [newest] = (await s.list({ limit: 1 })).items;
    assert.equal(await s.markRead(newest!.id), true);
    assert.equal(await s.unreadCount(), 3);
    assert.ok((await s.get(newest!.id)).read_at);
    assert.equal(await s.markUnread(newest!.id), true);
    assert.equal(await s.unreadCount(), 4);
    assert.equal((await s.list({ unreadOnly: true })).items.length, 4);
    assert.equal(await s.markAllRead(), 4);
    assert.equal(await s.unreadCount(), 0);
    assert.deepEqual((await s.list({ unreadOnly: true })).items, []);
  });
});

describe('only the owner', () => {
  test("someone else's notification cannot be read, changed or counted", async () => {
    const [mine] = (await u.member.services.notifications.list({ limit: 1 })).items;
    await rejects(u.other.services.notifications.get(mine!.id), ErrorCode.NotFound);
    await rejects(u.owner.services.notifications.get(mine!.id), ErrorCode.NotFound);
    assert.equal(await u.other.services.notifications.markRead(mine!.id), false);
    assert.equal(await u.other.services.notifications.markAllRead(), 0);
    // Routing data is immutable, even for its owner.
    const { error } = await u.member.client.from('notifications').update({ data: { post_id: id.post } }).eq('id', mine!.id);
    assert.ok(error);
  });

  test('the destination is authorized when opened, not by the notification', async () => {
    const all = (await u.member.services.notifications.list({ limit: 50 })).items;
    const post = all.find((n) => n.type === 'comment')!;
    // The post is hidden after the notification was sent: the link no longer opens it.
    await u.owner.services.posts.hide(id.post, 'Off topic');
    assert.equal((await u.member.services.posts.get((post.data as { post_id: string }).post_id)).status, 'hidden', 'the author still sees their own post');
    await rejects(u.other.services.posts.get(id.post), ErrorCode.NotFound);
    await rejects(u.other.services.announcements.get(id.announcement), ErrorCode.NotFound);
    // A member who leaves loses the community's notifications and their targets.
    const { data: m } = await admin.from('memberships').select('id').eq('community_id', c.A).eq('user_id', u.member.id).single().throwOnError();
    await admin.from('memberships').update({ status: 'suspended' }).eq('id', m!.id).throwOnError();
    const left = (await u.member.services.notifications.list({ limit: 50 })).items;
    assert.ok(!left.some((n) => n.type === 'announcement' || n.type === 'alert'), 'community notifications are hidden');
    await rejects(u.member.services.announcements.get(id.announcement), ErrorCode.NotFound);
    await rejects(u.member.services.events.get(id.event), ErrorCode.NotFound);
  });
});

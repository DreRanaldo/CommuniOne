// What the mobile community home relies on (RN-06), against the real local
// Supabase: the four summary lists and the community details return the
// current community's content to its active members, ordered for the home,
// and nothing to anyone else.
//
//   A: owner (Owner), member (Member), pending (pending)     B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'member' | 'pending' | 'other', TestUser>;
const c: Record<string, string> = {};
const inDays = (days: number, hours = 0) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString();

before(async () => {
  u = await users('owner', 'member', 'pending', 'other');
  c.A = await community(u.owner, 'HomeA');
  c.B = await community(u.other, 'HomeB');
  await addMember(c.A, u.member.id, 'Member');
  await addMember(c.A, u.pending.id, null, 'pending');

  const s = u.owner.services;
  await s.alerts.create({ communityId: c.A, title: 'Info notice', body: 'FYI', severity: 'info', publish: true });
  await s.alerts.create({ communityId: c.A, title: 'Gas leak', body: 'Evacuate block C', severity: 'emergency', publish: true });
  await s.announcements.create({ communityId: c.A, title: 'Newsletter', body: 'Monthly news', publish: true });
  await s.announcements.create({ communityId: c.A, title: 'AGM date', body: 'Vote', priority: 'important', publish: true });
  await s.events.create({ communityId: c.A, title: 'Later event', startsAt: inDays(9), endsAt: inDays(9, 2), publish: true });
  await s.events.create({ communityId: c.A, title: 'Sooner event', startsAt: inDays(2), endsAt: inDays(2, 2), publish: true });
  await s.posts.create({ communityId: c.A, body: 'Hello neighbours' });
  // Content in another community, which must never appear in A's home.
  await u.other.services.announcements.create({ communityId: c.B, title: 'B only', body: 'x', publish: true });
});
after(() => cleanupCommunityContent(Object.values(c)));

const homeOf = (user: TestUser, communityId: string) =>
  Promise.all([
    user.services.alerts.listActive({ communityId, limit: 5 }),
    user.services.announcements.listCurrent({ communityId, limit: 3 }),
    user.services.events.listUpcoming({ communityId, limit: 3 }),
    user.services.posts.list({ communityId, limit: 3 }),
  ]);

describe('community home data', () => {
  test('a member gets the community\'s content, in home priority order, and only that community\'s', async () => {
    const [alerts, announcements, events, posts] = await homeOf(u.member, c.A!);
    assert.deepEqual(alerts.items.map((a) => a.title), ['Gas leak', 'Info notice'], 'emergencies first');
    assert.deepEqual(announcements.items.map((a) => a.title), ['AGM date', 'Newsletter'], 'important first');
    assert.deepEqual(events.items.map((e) => e.title), ['Sooner event', 'Later event'], 'soonest first');
    assert.deepEqual(posts.items.map((p) => p.body), ['Hello neighbours']);
    for (const item of [...alerts.items, ...announcements.items, ...events.items, ...posts.items]) {
      assert.equal(item.community_id, c.A, 'every item belongs to the requested community');
    }
    assert.equal((await u.member.services.communities.get(c.A!)).id, c.A);
  });

  test('a member of another community gets nothing and cannot see the community', async () => {
    const lists = await homeOf(u.other, c.A!);
    assert.ok(lists.every((page) => page.items.length === 0));
    await rejects(u.other.services.communities.get(c.A!), ErrorCode.NotFound);
  });

  test('a pending applicant gets nothing yet', async () => {
    const lists = await homeOf(u.pending, c.A!);
    assert.ok(lists.every((page) => page.items.length === 0));
    await rejects(u.pending.services.communities.get(c.A!), ErrorCode.NotFound);
  });

  test('the summary limits are honoured', async () => {
    const [, announcements] = await homeOf(u.member, c.A!);
    const one = await u.member.services.announcements.listCurrent({ communityId: c.A!, limit: 1 });
    assert.equal(one.items.length, 1);
    assert.ok(one.nextCursor, 'more are available through "See all"');
    assert.equal(announcements.items.length, 2);
  });
});

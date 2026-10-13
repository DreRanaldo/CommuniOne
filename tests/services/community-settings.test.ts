// What the mobile community settings rely on (RN-15), against the real local
// Supabase: per-community notification preferences (enforced when real
// producers notify), community details and images (community.update only),
// and leaving (refused for the last member able to manage roles).
//
//   A: owner (Owner), admin (Admin), member (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'admin' | 'member' | 'other', TestUser>;
const c: Record<string, string> = {};
const png = () => Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));

before(async () => {
  u = await users('owner', 'admin', 'member', 'other');
  c.A = await community(u.owner, 'SetA');
  c.B = await community(u.other, 'SetB');
  await addMember(c.A, u.admin.id, 'Admin');
  await addMember(c.A, u.member.id, 'Member');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('notification preferences', () => {
  test('defaults, partial changes, and refusal outside your communities', async () => {
    const s = u.member.services.communities;
    assert.deepEqual(await s.notificationSettings(c.A), { announcements: true, events: true, comments: true, alerts: true });
    assert.deepEqual(await s.setNotificationSettings(c.A, { announcements: false }), { announcements: false, events: true, comments: true, alerts: true });
    assert.deepEqual(await s.setNotificationSettings(c.A, { alerts: false }), { announcements: false, events: true, comments: true, alerts: false });
    await rejects(s.notificationSettings(c.B), ErrorCode.Forbidden);
    await rejects(s.setNotificationSettings(c.B, { events: false }), ErrorCode.Forbidden);
    await rejects(s.setNotificationSettings(c.A, { events: 'no' as unknown as boolean }), ErrorCode.Validation, 'events');
  });

  test('real producers honour them; urgent alerts always arrive', async () => {
    await u.owner.services.announcements.create({ communityId: c.A, title: 'Pool opens', body: 'Saturday', publish: true });
    await u.owner.services.alerts.create({ communityId: c.A, title: 'Bin day moved', body: 'Thursday', severity: 'info', publish: true });
    await u.owner.services.alerts.create({ communityId: c.A, title: 'Gas leak', body: 'Leave now', severity: 'urgent', publish: true });
    const mine = (await u.member.services.notifications.list({ limit: 50 })).items.map((n) => `${n.type}:${n.title}`);
    assert.ok(!mine.some((t) => t.startsWith('announcement')), 'announcements were turned off');
    assert.ok(!mine.includes('alert:Bin day moved'), 'non-urgent alerts were turned off');
    assert.ok(mine.includes('alert:Gas leak'), 'an urgent alert is always delivered');
    const admin = (await u.admin.services.notifications.list({ limit: 50 })).items.map((n) => n.type);
    assert.ok(admin.includes('announcement') && admin.filter((t) => t === 'alert').length === 2, 'others are unaffected');
  });
});

describe('community details', () => {
  test('an Admin edits name, description, type, time zone and images', async () => {
    const s = u.admin.services.communities;
    const updated = await s.update(c.A, { name: 'Settings A', description: 'Our street', type: 'church', timezone: 'Europe/London' });
    assert.equal(updated.name, 'Settings A');
    assert.equal(updated.timezone, 'Europe/London');
    const withLogo = await s.uploadImage(c.A, 'logo', { file: png(), mimeType: 'image/png' });
    assert.ok(withLogo.logo_path);
    const cleared = await s.removeImage(c.A, 'logo');
    assert.equal(cleared.logo_path, null);
    await rejects(s.update(c.A, { timezone: 'Mars/Olympus' }), ErrorCode.Validation);
  });

  test('members and outsiders cannot change anything', async () => {
    await rejects(u.member.services.communities.update(c.A, { name: 'Hijacked' }), ErrorCode.Forbidden);
    await rejects(u.member.services.communities.uploadImage(c.A, 'cover', { file: png(), mimeType: 'image/png' }), ErrorCode.Forbidden);
    await rejects(u.other.services.communities.update(c.A, { name: 'Hijacked' }), ErrorCode.NotFound);
    assert.equal((await u.owner.services.communities.get(c.A)).name, 'Settings A');
  });
});

describe('leaving', () => {
  test('the Owner (only role manager) cannot leave; others can, and lose access', async () => {
    await rejects(u.owner.services.memberships.leave(c.A), ErrorCode.Forbidden);
    await u.member.services.memberships.leave(c.A);
    await rejects(u.member.services.communities.notificationSettings(c.A), ErrorCode.Forbidden);
    assert.ok(!(await u.member.services.communities.listMine()).some((m) => m.community_id === c.A && m.membership_status === 'active'));
    await u.admin.services.memberships.leave(c.A);
  });
});

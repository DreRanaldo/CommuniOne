// What the mobile alert screens rely on (RN-10), against the real local
// Supabase: active ordering and expiry, history, draft visibility, the
// emergency rules, the lifecycle (cancel / expire / archive), and isolation.
//
//   A: owner (Owner: alerts.manage), creator (Member + alerts.create), member (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'creator' | 'member' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  u = await users('owner', 'creator', 'member', 'other');
  c.A = await community(u.owner, 'AlertA');
  c.B = await community(u.other, 'AlertB');
  await addMember(c.A, u.creator.id, 'Member');
  await addMember(c.A, u.member.id, 'Member');
  const { data: role } = await admin.from('roles').insert({ community_id: c.A, name: 'Warden' }).select('id').single().throwOnError();
  const { data: perm } = await admin.from('permissions').select('id').eq('key', 'alerts.create').single().throwOnError();
  await admin.from('role_permissions').insert({ role_id: role!.id, permission_id: perm!.id }).throwOnError();
  const { data: m } = await admin.from('memberships').select('id').eq('community_id', c.A).eq('user_id', u.creator.id).single().throwOnError();
  await admin.from('membership_roles').insert({ membership_id: m!.id, role_id: role!.id }).throwOnError();

  const s = u.owner.services.alerts;
  id.info = (await s.create({ communityId: c.A, title: 'Info', body: 'b', severity: 'info', publish: true })).id;
  id.emergency = (await s.create({ communityId: c.A, title: 'Fire', body: 'Evacuate', severity: 'emergency', publish: true })).id;
  id.urgent = (await s.create({ communityId: c.A, title: 'Gas', body: 'Smell', severity: 'urgent', publish: true })).id;
  id.expiring = (await s.create({ communityId: c.A, title: 'Short', body: 'b', severity: 'warning', publish: true, expiresAt: inHours(1) })).id;
  await admin.from('alerts').update({ published_at: inHours(-3), expires_at: inHours(-1) }).eq('id', id.expiring).throwOnError();
  id.ownerDraft = (await s.create({ communityId: c.A, title: 'Owner draft', body: 'b' })).id;
  id.creatorDraft = (await u.creator.services.alerts.create({ communityId: c.A, title: 'Creator draft', body: 'b', severity: 'warning' })).id;
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('reading alerts', () => {
  test('active: emergencies first, by severity; expired ones are not active', async () => {
    const page = await u.member.services.alerts.listActive({ communityId: c.A! });
    assert.deepEqual(page.items.map((a) => [a.title, a.severity, a.is_emergency]), [
      ['Fire', 'emergency', true],
      ['Gas', 'urgent', false],
      ['Info', 'info', false],
    ]);
  });

  test('history: past alerts with their state; drafts only for managers and their creator', async () => {
    const history = await u.member.services.alerts.listHistory({ communityId: c.A! });
    const short = history.items.find((a) => a.title === 'Short');
    assert.deepEqual([short?.status, short?.is_active], ['published', false], 'time-expired: published but not active');
    assert.deepEqual((await u.member.services.alerts.listHistory({ communityId: c.A!, statuses: ['draft'] })).items, []);
    const forCreator = await u.creator.services.alerts.listHistory({ communityId: c.A!, statuses: ['draft'] });
    assert.deepEqual(forCreator.items.map((a) => a.title), ['Creator draft']);
    const forOwner = await u.owner.services.alerts.listHistory({ communityId: c.A!, statuses: ['draft'] });
    assert.deepEqual(forOwner.items.map((a) => a.title).sort(), ['Creator draft', 'Owner draft']);
  });
});

describe('who may create and manage', () => {
  test('members and creators send alerts but no emergencies; managers can', async () => {
    await rejects(u.member.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y', severity: 'emergency' }), ErrorCode.Forbidden);
    await rejects(u.creator.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y', severity: 'emergency' }), ErrorCode.Forbidden);
    const urgent = await u.creator.services.alerts.create({ communityId: c.A!, title: 'Ice', body: 'Slippery', severity: 'urgent', publish: true });
    assert.equal(urgent.status, 'published');
    // After publication, only managers change severity; nobody but managers escalates to emergency.
    await rejects(u.creator.services.alerts.edit(urgent.id, { severity: 'warning' }), ErrorCode.Forbidden);
    await rejects(u.creator.services.alerts.edit(id.creatorDraft!, { severity: 'emergency' }), ErrorCode.Forbidden);
    assert.equal((await u.owner.services.alerts.edit(urgent.id, { severity: 'emergency' })).severity, 'emergency');
    // A creator manages only their own alerts.
    await rejects(u.creator.services.alerts.cancel(id.info!, 'not mine'), ErrorCode.Forbidden);
    await rejects(u.member.services.alerts.cancel(id.info!), ErrorCode.Forbidden);
  });

  test('lifecycle: publish, cancel with a reason, end now, archive; archived is final', async () => {
    const s = u.owner.services.alerts;
    const published = await s.publish(id.ownerDraft!);
    assert.ok(published.published_at);
    const cancelled = await s.cancel(id.ownerDraft!, 'Resolved');
    assert.deepEqual([cancelled.status, cancelled.cancellation_reason, !!cancelled.cancelled_at], ['cancelled', 'Resolved', true]);
    const archived = await s.archive(id.ownerDraft!);
    assert.equal(archived.status, 'archived');
    await rejects(s.publish(id.ownerDraft!), ErrorCode.Forbidden);

    const ended = await s.expire(id.urgent!);
    assert.deepEqual([ended.status, !!ended.expired_at], ['expired', true]);
    assert.ok(!(await u.member.services.alerts.listActive({ communityId: c.A! })).items.some((a) => a.id === id.urgent));
    await rejects(s.archive(id.emergency!), ErrorCode.Validation, undefined);
    await rejects(s.create({ communityId: c.A!, title: 'Late', body: 'b', publish: true, expiresAt: inHours(-1) }), ErrorCode.Validation);
  });

  test('another community\'s manager has no power here', async () => {
    assert.deepEqual((await u.other.services.alerts.listActive({ communityId: c.A! })).items, []);
    await rejects(u.other.services.alerts.cancel(id.emergency!, 'x'), ErrorCode.NotFound);
    await rejects(u.other.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y' }), ErrorCode.Forbidden);
  });
});

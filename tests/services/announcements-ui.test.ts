// What the mobile announcements screens rely on (RN-09), against the real
// local Supabase: current vs past lists, expiry, draft visibility, the
// lifecycle, and who may manage which announcement.
//
//   A: owner (Owner: announcements.manage), author (Member + announcements.create),
//      member (Member)                      B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'author' | 'member' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  u = await users('owner', 'author', 'member', 'other');
  c.A = await community(u.owner, 'AnnA');
  c.B = await community(u.other, 'AnnB');
  await addMember(c.A, u.author.id, 'Member');
  await addMember(c.A, u.member.id, 'Member');
  // Give the author announcements.create through a custom role (not manage).
  const { data: role } = await admin.from('roles').insert({ community_id: c.A, name: 'Editor' }).select('id').single().throwOnError();
  const { data: perm } = await admin.from('permissions').select('id').eq('key', 'announcements.create').single().throwOnError();
  await admin.from('role_permissions').insert({ role_id: role!.id, permission_id: perm!.id }).throwOnError();
  const { data: membership } = await admin.from('memberships').select('id').eq('community_id', c.A).eq('user_id', u.author.id).single().throwOnError();
  await admin.from('membership_roles').insert({ membership_id: membership!.id, role_id: role!.id }).throwOnError();

  const s = u.owner.services.announcements;
  id.normal = (await s.create({ communityId: c.A, title: 'Pool opens', body: 'Saturday', publish: true })).id;
  id.important = (await s.create({ communityId: c.A, title: 'Water off', body: 'Tuesday 9-12', priority: 'important', publish: true })).id;
  id.expiring = (await s.create({ communityId: c.A, title: 'Short notice', body: 'Soon gone', publish: true, expiresAt: inHours(1) })).id;
  id.ownerDraft = (await s.create({ communityId: c.A, title: 'Owner draft', body: 'Not yet' })).id;
  id.authorDraft = (await u.author.services.announcements.create({ communityId: c.A, title: 'Author draft', body: 'WIP' })).id;
  // Let one expire (server-side clock): move its dates into the past as a trusted backend.
  await admin.from('announcements').update({ published_at: inHours(-3), expires_at: inHours(-1) }).eq('id', id.expiring).throwOnError();
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('announcement lists', () => {
  test('current: published and not expired, important first', async () => {
    const page = await u.member.services.announcements.listCurrent({ communityId: c.A! });
    assert.deepEqual(page.items.map((a) => a.title), ['Water off', 'Pool opens']);
  });

  test('past: published (with expired flagged) and archived, never drafts for members', async () => {
    const page = await u.member.services.announcements.listHistory({ communityId: c.A! });
    const byTitle = Object.fromEntries(page.items.map((a) => [a.title, a]));
    assert.equal(byTitle['Short notice']?.is_expired, true);
    assert.equal(byTitle['Pool opens']?.is_expired, false);
    const drafts = await u.member.services.announcements.listHistory({ communityId: c.A!, statuses: ['draft'] });
    assert.deepEqual(drafts.items, [], 'members receive no drafts even when asking');
  });

  test('drafts: managers see all, authors only their own', async () => {
    const forOwner = await u.owner.services.announcements.listHistory({ communityId: c.A!, statuses: ['draft'] });
    assert.deepEqual(forOwner.items.map((a) => a.title).sort(), ['Author draft', 'Owner draft']);
    const forAuthor = await u.author.services.announcements.listHistory({ communityId: c.A!, statuses: ['draft'] });
    assert.deepEqual(forAuthor.items.map((a) => a.title), ['Author draft']);
    await rejects(u.member.services.announcements.get(id.ownerDraft!), ErrorCode.NotFound);
  });
});

describe('managing announcements', () => {
  test('members cannot create; authors manage only their own; managers any', async () => {
    await rejects(u.member.services.announcements.create({ communityId: c.A!, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(u.author.services.announcements.edit(id.normal!, { title: 'Hijack' }), ErrorCode.Forbidden);
    await rejects(u.member.services.announcements.archive(id.normal!), ErrorCode.Forbidden);
    const edited = await u.author.services.announcements.edit(id.authorDraft!, { title: 'Author draft v2' });
    assert.equal(edited.title, 'Author draft v2');
    const byOwner = await u.owner.services.announcements.edit(id.authorDraft!, { priority: 'important' });
    assert.equal(byOwner.priority, 'important');
  });

  test('lifecycle: publish stamps the date, edits mark published ones, archive and republish', async () => {
    const s = u.owner.services.announcements;
    const published = await s.publish(id.ownerDraft!);
    assert.ok(published.published_at);
    assert.equal(published.edited_at, null);
    const edited = await s.edit(id.ownerDraft!, { body: 'Now' });
    assert.ok(edited.edited_at, 'edits after publication are marked');
    const archived = await s.archive(id.ownerDraft!);
    assert.deepEqual([archived.status, !!archived.archived_at], ['archived', true]);
    await rejects(s.edit(id.ownerDraft!, { title: 'No' }), ErrorCode.Forbidden);
    assert.equal((await s.publish(id.ownerDraft!)).status, 'published');
    assert.equal((await s.delete(id.ownerDraft!)).status, 'deleted');
    // Terminal: managers still see it, and the trigger refuses any change.
    const error = await rejects(s.publish(id.ownerDraft!), ErrorCode.Forbidden);
    assert.match(error.message, /deleted announcements cannot be modified/i);
    await rejects(u.member.services.announcements.get(id.ownerDraft!), ErrorCode.NotFound);
  });

  test('invalid transitions and past expiry are refused', async () => {
    const s = u.owner.services.announcements;
    const draft = await s.create({ communityId: c.A!, title: 'Draft', body: 'b' });
    await rejects(s.archive(draft.id), ErrorCode.Validation);
    await rejects(s.create({ communityId: c.A!, title: 'Late', body: 'b', publish: true, expiresAt: inHours(-1) }), ErrorCode.Validation);
    await s.edit(draft.id, { expiresAt: inHours(-2) });
    const error = await rejects(s.publish(draft.id), ErrorCode.Validation);
    assert.match(error.message, /expires_at must be in the future/i);
  });

  test('another community\'s manager has no power here', async () => {
    assert.deepEqual((await u.other.services.announcements.listCurrent({ communityId: c.A! })).items, []);
    await rejects(u.other.services.announcements.archive(id.normal!), ErrorCode.NotFound);
    await rejects(u.other.services.announcements.create({ communityId: c.A!, title: 'x', body: 'y' }), ErrorCode.Forbidden);
  });
});

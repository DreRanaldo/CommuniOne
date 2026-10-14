// Service-layer security: cross-community access, member → admin escalation,
// impersonation, tampering with other people's content, ID manipulation,
// RLS bypass through the raw Data API, rate limiting and log safety.
//
//   Community A: ownerA (Owner), adminA (Admin), memberA, memberA2 (Member)
//   Community B: ownerB (Owner), memberB (Member)
// memberA belongs to A only; memberB to B only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { encodeCursor } from '../../services/core/pagination.ts';
import { createServices, ErrorCode, type Database } from '../../services/index.ts';
import { ANON_KEY, rest, signLegacyJwt, SUPABASE_URL } from '../integration/helpers.mjs';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'ownerA' | 'adminA' | 'memberA' | 'memberA2' | 'ownerB' | 'memberB', TestUser>;
const c: Record<string, string> = {};
const a: Record<string, string> = {}; // ids of community A resources
const inOneDay = (h = 0) => new Date(Date.now() + (24 + h) * 3600_000).toISOString();

before(async () => {
  u = await users('ownerA', 'adminA', 'memberA', 'memberA2', 'ownerB', 'memberB');
  c.A = await community(u.ownerA, 'SA');
  c.B = await community(u.ownerB, 'SB');
  a.adminMembership = await addMember(c.A, u.adminA.id, 'Admin');
  a.memberMembership = await addMember(c.A, u.memberA.id, 'Member');
  await addMember(c.A, u.memberA2.id, 'Member');
  await addMember(c.B, u.memberB.id, 'Member');

  const s = u.adminA.services;
  a.post = (await u.memberA.services.posts.create({ communityId: c.A, body: 'A only' })).id;
  a.comment = (await u.memberA.services.comments.create({ postId: a.post, body: 'A comment' })).id;
  a.announcement = (await s.announcements.create({ communityId: c.A, title: 'A news', body: 'x', publish: true })).id;
  a.alert = (await s.alerts.create({ communityId: c.A, title: 'A alert', body: 'x', publish: true })).id;
  a.event = (await s.events.create({ communityId: c.A, title: 'A event', startsAt: inOneDay(), endsAt: inOneDay(1), publish: true })).id;
  a.doc = (await s.documents.upload({ communityId: c.A, name: 'A.pdf', mimeType: 'application/pdf', file: new Blob(['%PDF-1.4 A']) })).id;
  a.invite = (await s.invitations.create({ communityId: c.A })).invitationId;
  const notes = await u.memberA.services.notifications.list();
  a.notification = notes.items[0].id;
});
after(async () => {
  const { data: docs } = await admin.from('documents').select('storage_path').in('community_id', Object.values(c));
  const paths = (docs ?? []).map((d) => d.storage_path).filter((p): p is string => !!p);
  if (paths.length) await admin.storage.from('documents').remove(paths);
  await cleanupCommunityContent(Object.values(c));
});

describe('a member of A cannot reach community B', () => {
  test('every read of B is NOT_FOUND or empty', async () => {
    const s = u.memberA.services;
    await rejects(s.communities.get(c.B), ErrorCode.NotFound);
    assert.deepEqual(await s.communities.myPermissions(c.B), []);
    assert.deepEqual((await s.memberships.list({ communityId: c.B })).items, []);
    assert.deepEqual(await s.roles.list(c.B), []);
    assert.deepEqual((await s.posts.list({ communityId: c.B })).items, []);
    assert.deepEqual((await s.announcements.listCurrent({ communityId: c.B })).items, []);
    assert.deepEqual((await s.announcements.listHistory({ communityId: c.B })).items, []);
    assert.deepEqual((await s.alerts.listActive({ communityId: c.B })).items, []);
    assert.deepEqual((await s.alerts.listHistory({ communityId: c.B })).items, []);
    assert.deepEqual((await s.events.listUpcoming({ communityId: c.B })).items, []);
    assert.deepEqual((await s.events.list({ communityId: c.B })).items, []);
    assert.deepEqual((await s.documents.list({ communityId: c.B })).items, []);
    assert.deepEqual(await s.documents.listFolders(c.B), []);
    assert.deepEqual((await s.audit.list({ communityId: c.B })).items, []);
    assert.deepEqual(await s.invitations.list({ communityId: c.B }), []);
    assert.deepEqual((await s.notifications.list({ communityId: c.B })).items, []);
  });

  test('every write into B is refused', async () => {
    const s = u.memberA.services;
    await rejects(s.communities.update(c.B, { name: 'x' }), ErrorCode.NotFound);
    await rejects(s.posts.create({ communityId: c.B, body: 'x' }), ErrorCode.Forbidden);
    await rejects(s.announcements.create({ communityId: c.B, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(s.alerts.create({ communityId: c.B, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(s.events.create({ communityId: c.B, title: 'x', startsAt: inOneDay(), endsAt: inOneDay(1) }), ErrorCode.Forbidden);
    await rejects(s.documents.upload({ communityId: c.B, name: 'x.pdf', mimeType: 'application/pdf', file: new Blob(['%PDF']) }), ErrorCode.Forbidden);
    await rejects(s.documents.createFolder({ communityId: c.B, name: 'x' }), ErrorCode.Forbidden);
    await rejects(s.invitations.create({ communityId: c.B }), ErrorCode.Forbidden);
  });
});

describe('replacing an id with another community\'s id (IDOR)', () => {
  test('B\'s member gets NOT_FOUND / nothing for every A resource', async () => {
    const s = u.memberB.services;
    await rejects(s.posts.get(a.post), ErrorCode.NotFound);
    await rejects(s.posts.edit(a.post, 'x'), ErrorCode.NotFound);
    await rejects(s.posts.hide(a.post), ErrorCode.NotFound);
    await rejects(s.posts.delete(a.post), ErrorCode.NotFound);
    await rejects(s.posts.react({ postId: a.post, type: 'like' }), ErrorCode.Forbidden);
    assert.deepEqual(await s.posts.reactionSummary({ postIds: [a.post] }), []);
    assert.deepEqual((await s.comments.list({ postId: a.post })).items, []);
    await rejects(s.comments.create({ postId: a.post, body: 'x' }), ErrorCode.Forbidden);
    await rejects(s.comments.edit(a.comment, 'x'), ErrorCode.NotFound);
    await rejects(s.announcements.get(a.announcement), ErrorCode.NotFound);
    await rejects(s.announcements.archive(a.announcement), ErrorCode.NotFound);
    await rejects(s.alerts.get(a.alert), ErrorCode.NotFound);
    await rejects(s.alerts.cancel(a.alert), ErrorCode.NotFound);
    await rejects(s.events.get(a.event), ErrorCode.NotFound);
    await rejects(s.events.cancel(a.event), ErrorCode.NotFound);
    await rejects(s.events.attendance(a.event), ErrorCode.NotFound);
    await rejects(s.events.rsvp(a.event, 'going'), ErrorCode.Forbidden);
    await rejects(s.documents.get(a.doc), ErrorCode.NotFound);
    await rejects(s.documents.getDownloadUrl(a.doc), ErrorCode.NotFound);
    await rejects(s.documents.rename(a.doc, 'x.pdf'), ErrorCode.NotFound);
    await rejects(s.memberships.suspend(a.memberMembership), ErrorCode.NotFound);
    await rejects(s.memberships.remove(a.memberMembership), ErrorCode.NotFound);
    await rejects(s.invitations.revoke(a.invite), ErrorCode.NotFound);
    assert.equal(await s.notifications.markRead(a.notification), false);
    assert.equal(await s.notifications.delete(a.notification), false);
  });

  test('even B\'s Owner cannot act on A through A\'s ids', async () => {
    const s = u.ownerB.services;
    await rejects(s.memberships.approve(a.memberMembership), ErrorCode.NotFound);
    await rejects(s.posts.hide(a.post), ErrorCode.NotFound);
    await rejects(s.documents.delete(a.doc), ErrorCode.NotFound);
    const bRoles = await s.roles.list(c.B);
    await rejects(s.roles.assign(a.memberMembership, bRoles[0].id), ErrorCode.Forbidden);
  });

  test('malformed ids and tampered cursors are rejected before the database', async () => {
    const s = u.memberA.services;
    for (const bad of ['', '1', "' or '1'='1", `${c.A}' --`, `${c.A},community_id.eq.${c.B}`]) {
      await rejects(s.communities.get(bad), ErrorCode.Validation, 'communityId');
      await rejects(s.posts.get(bad), ErrorCode.Validation, 'postId');
    }
    const injected = encodeCursor([`2026-01-01T00:00:00Z,community_id.eq.${c.B}`, a.post]);
    await rejects(s.memberships.list({ communityId: c.A, cursor: injected }), ErrorCode.Validation, 'cursor');
    await rejects(s.posts.list({ communityId: c.A, cursor: 'garbage!' }), ErrorCode.Validation, 'cursor');
  });

  test('a cursor taken from A\'s feed does not unlock B', async () => {
    const page = await u.memberA.services.posts.list({ communityId: c.A, limit: 1 });
    const crafted = encodeCursor(['2999-01-01T00:00:00Z', 'ffffffff-ffff-4fff-bfff-ffffffffffff']);
    assert.deepEqual((await u.memberA.services.posts.list({ communityId: c.B, cursor: page.nextCursor ?? crafted })).items, []);
  });
});

describe('a member attempting admin operations', () => {
  test('is refused everywhere', async () => {
    const s = u.memberA.services;
    await rejects(s.communities.update(c.A, { name: 'Mine now' }), ErrorCode.Forbidden);
    await rejects(s.memberships.suspend(a.adminMembership), ErrorCode.Forbidden);
    await rejects(s.memberships.remove(a.adminMembership), ErrorCode.Forbidden);
    const owner = (await s.roles.list(c.A)).find((r) => r.name === 'Owner');
    assert.ok(owner);
    await rejects(s.roles.assign(a.memberMembership, owner.id), ErrorCode.Forbidden);
    await rejects(s.invitations.create({ communityId: c.A }), ErrorCode.Forbidden);
    assert.deepEqual(await s.invitations.list({ communityId: c.A }), []);
    await rejects(s.invitations.revoke(a.invite), ErrorCode.NotFound);
    await rejects(s.announcements.create({ communityId: c.A, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(s.announcements.archive(a.announcement), ErrorCode.Forbidden);
    await rejects(s.alerts.create({ communityId: c.A, title: 'x', body: 'y', severity: 'emergency' }), ErrorCode.Forbidden);
    await rejects(s.events.create({ communityId: c.A, title: 'x', startsAt: inOneDay(), endsAt: inOneDay(1) }), ErrorCode.Forbidden);
    await rejects(s.events.cancel(a.event), ErrorCode.Forbidden);
    await rejects(s.documents.upload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', file: new Blob(['%PDF']) }), ErrorCode.Forbidden);
    await rejects(s.documents.createFolder({ communityId: c.A, name: 'x' }), ErrorCode.Forbidden);
    await rejects(s.posts.hide(a.post), ErrorCode.Forbidden);
    assert.deepEqual((await s.audit.list({ communityId: c.A })).items, []);
    assert.deepEqual((await s.audit.list()).items, [], 'system events are for platform admins only');
  });
});

describe('impersonation', () => {
  test('authorship and identity fields cannot be supplied', async () => {
    const s = u.memberA2.services;
    // @ts-expect-error not part of the input
    await rejects(s.posts.create({ communityId: c.A, body: 'x', authorUserId: u.ownerA.id }), ErrorCode.Validation, 'authorUserId');
    // Through the raw Data API the column is not writable at all.
    const raw = await u.memberA2.client.from('posts').insert({ community_id: c.A, body: 'x', author_user_id: u.ownerA.id } as never);
    assert.equal(raw.error?.code, '42501');
    const rsvp = await u.memberA2.client.from('event_rsvps').insert({ event_id: a.event, status: 'going', user_id: u.memberA.id } as never);
    assert.equal(rsvp.error?.code, '42501');
  });

  test('a token for someone else is useless without their session', async () => {
    // Correctly signed, but for a session that does not exist.
    const forged = signLegacyJwt({
      sub: u.ownerA.id, role: 'authenticated', aud: 'authenticated', session_id: '00000000-0000-4000-8000-000000000000',
      exp: Math.floor(Date.now() / 1000) + 600, is_anonymous: false,
    });
    const { body } = await rest('rpc/my_communities', { method: 'POST', token: forged, body: {} });
    assert.deepEqual(body, []);
    const tampered = (await rest('rpc/my_communities', { method: 'POST', token: `${forged.slice(0, -4)}AAAA`, body: {} }));
    assert.equal(tampered.status, 401);
  });

  test('services without a session refuse before any request', async () => {
    const anon = createServices(createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } }));
    await rejects(anon.posts.list({ communityId: c.A }), ErrorCode.Unauthenticated);
    await rejects(anon.invitations.redeem(`ci_${'a'.repeat(64)}`), ErrorCode.Unauthenticated);
  });
});

describe('modifying another user\'s content', () => {
  test('is refused for posts, comments, RSVPs, notifications and profiles', async () => {
    const s = u.memberA2.services;
    await rejects(s.posts.edit(a.post, 'Edited by someone else'), ErrorCode.Forbidden);
    await rejects(s.posts.delete(a.post), ErrorCode.Forbidden);
    await rejects(s.comments.edit(a.comment, 'x'), ErrorCode.Forbidden);
    await rejects(s.comments.delete(a.comment), ErrorCode.Forbidden);
    assert.equal(await s.notifications.markRead(a.notification), false);
    const profile = await u.memberA2.client.from('profiles').update({ display_name: 'Hacked' }).eq('id', u.memberA.id).select();
    assert.deepEqual(profile.data, []);
    const { data } = await admin.from('posts').select('body, status').eq('id', a.post).single();
    assert.deepEqual(data, { body: 'A only', status: 'published' });
  });
});

describe('bypassing the service layer and RLS through the raw Data API', () => {
  test('raw reads of B return nothing; protected columns and tables are closed', async () => {
    const raw = u.memberA.client;
    for (const table of ['posts', 'comments', 'announcements', 'alerts', 'events', 'documents', 'memberships', 'roles', 'audit_logs', 'invitations'] as const) {
      const { data, error } = await raw.from(table).select('id').eq('community_id', c.B);
      assert.ok(error || data?.length === 0, `${table} leaked B rows`);
    }
    assert.equal((await raw.from('invitations').select('token_hash')).error?.code, '42501');
    assert.deepEqual((await raw.from('profile_private').select('phone').neq('user_id', u.memberA.id)).data, []);
    assert.deepEqual((await raw.from('notifications').select('id').neq('user_id', u.memberA.id)).data, []);
  });

  test('raw writes that skip business rules are refused', async () => {
    const raw = u.memberA.client;
    assert.equal((await raw.from('memberships').insert({ community_id: c.B, user_id: u.memberA.id } as never)).error?.code, '42501');
    assert.equal((await raw.from('communities').update({ status: 'archived' } as never).eq('id', c.A)).error?.code, '42501');
    assert.equal((await raw.from('notifications').insert({ user_id: u.memberA.id, type: 'system', title: 'x' } as never)).error?.code, '42501');
    assert.equal((await raw.from('audit_logs').insert({ action: 'community.updated', entity_type: 'community' } as never)).error?.code, '42501');
    // Members may send alerts (migration 31), never emergencies and never as someone else.
    assert.equal((await raw.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y', severity: 'emergency', status: 'published' })).error?.code, '42501');
    assert.equal((await raw.from('alerts').insert({ community_id: c.A, title: 'x', body: 'y', created_by: u.ownerA.id } as never)).error?.code, '42501');
  });

  test('server-only functions and the private schema are not callable', async () => {
    const raw = u.ownerA.client;
    assert.ok((await raw.rpc('create_notification', { p_user_id: u.memberA.id, p_community_id: c.A, p_type: 'system', p_title: 'x' })).error);
    assert.ok((await raw.rpc('expire_due_alerts')).error);
    assert.ok((await raw.rpc('purge_rate_limit_counters')).error);
    assert.ok((await raw.rpc('record_system_audit_event', { p_community_id: c.A, p_action: 'community.updated', p_entity_type: 'community' })).error);
    const { status } = await rest('rpc/enforce_rate_limit', { method: 'POST', token: (await raw.auth.getSession()).data.session?.access_token, body: { p_action: 'post.create' } });
    assert.equal(status, 404, 'private schema functions are not exposed');
  });
});

describe('rate limiting', () => {
  test('alert creation is limited per user, with a retry hint', async () => {
    const s = u.ownerA.services;
    let limited;
    for (let i = 0; i < 25 && !limited; i += 1) {
      try {
        await s.alerts.create({ communityId: c.A, title: `Drill ${i}`, body: 'test' });
      } catch (error) {
        limited = error;
      }
    }
    assert.ok(limited, 'the limit was reached');
    const error = await rejects(s.alerts.create({ communityId: c.A, title: 'One more', body: 'x' }), ErrorCode.RateLimited);
    assert.ok((error.details.retryAfterSeconds ?? 0) > 0);
    assert.ok(u.ownerA.logs.some((l) => l.event === 'service.rate_limited'));
    // Another user is unaffected.
    await u.adminA.services.alerts.create({ communityId: c.A, title: 'Admin is fine', body: 'x' });
  });
});

describe('logging', () => {
  test('no tokens, JWTs, emails or secrets reach the logs', async () => {
    const invite = await u.adminA.services.invitations.create({ communityId: c.A, maxUses: 1 });
    await u.memberB.services.invitations.redeem(invite.token);
    await rejects(u.memberB.services.invitations.redeem(invite.token), ErrorCode.Validation); // used up
    await rejects(u.memberA2.services.invitations.redeem(invite.token), ErrorCode.Validation);
    await rejects(u.memberA2.services.auth.signIn({ email: u.memberA2.email, password: 'wrong-password-1' }), ErrorCode.Unauthenticated);
    const all = JSON.stringify(Object.values(u).flatMap((x) => x.logs));
    assert.ok(all.length > 2, 'something was logged');
    assert.ok(!all.includes(invite.token.slice(3)), 'invitation token');
    assert.doesNotMatch(all, /eyJ[A-Za-z0-9_-]{8,}\./, 'JWT');
    assert.ok(!Object.values(u).some((x) => all.includes(x.email)), 'email address');
    assert.ok(!all.includes('wrong-password-1'), 'password');
  });
});

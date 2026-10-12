// Service layer: posts, comments, moderation, announcements, alerts, events,
// notifications and documents (main flows plus the permission edges).
//
//   Community A: owner (Owner), admin (Admin), mod (Moderator), member, member2, member3 (Member)
//   Community B: ownerB (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'admin' | 'mod' | 'member' | 'member2' | 'member3' | 'ownerB', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};

const pdf = (text: string) => new Blob([`%PDF-1.4\n${text}\n%%EOF`], { type: 'application/pdf' });
const inOneDay = (hours = 0) => new Date(Date.now() + (24 + hours) * 3600_000).toISOString();

before(async () => {
  u = await users('owner', 'admin', 'mod', 'member', 'member2', 'member3', 'ownerB');
  c.A = await community(u.owner, 'CA');
  c.B = await community(u.ownerB, 'CB');
  await addMember(c.A, u.admin.id, 'Admin');
  await addMember(c.A, u.mod.id, 'Moderator');
  for (const name of ['member', 'member2', 'member3'] as const) await addMember(c.A, u[name].id, 'Member');
});
after(async () => {
  const { data: docs } = await admin.from('documents').select('storage_path').in('community_id', Object.values(c));
  const paths = (docs ?? []).map((d) => d.storage_path).filter((p): p is string => !!p);
  if (paths.length) await admin.storage.from('documents').remove(paths);
  await cleanupCommunityContent(Object.values(c));
});

describe('posts and comments', () => {
  test('create post', async () => {
    const post = await u.member.services.posts.create({ communityId: c.A, body: '  Hello neighbours  ' });
    assert.deepEqual([post.body, post.author_user_id, post.status], ['Hello neighbours', u.member.id, 'published']);
    id.post = post.id;
  });

  test('create post: validation, impersonation and other communities', async () => {
    await rejects(u.member.services.posts.create({ communityId: c.A, body: '' }), ErrorCode.Validation, 'body');
    await rejects(u.member.services.posts.create({ communityId: c.A, body: 'x'.repeat(10_001) }), ErrorCode.Validation, 'body');
    await rejects(u.member.services.posts.create({ communityId: 'not-a-uuid', body: 'x' }), ErrorCode.Validation, 'communityId');
    // @ts-expect-error authorship cannot be supplied
    await rejects(u.member.services.posts.create({ communityId: c.A, body: 'x', author_user_id: u.owner.id }), ErrorCode.Validation, 'author_user_id');
    await rejects(u.member.services.posts.create({ communityId: c.B, body: 'into B' }), ErrorCode.Forbidden);
  });

  test('comment and reply', async () => {
    const comment = await u.member2.services.comments.create({ postId: id.post, body: 'Welcome!' });
    const reply = await u.member.services.comments.create({ postId: id.post, body: 'Thanks', parentCommentId: comment.id });
    assert.equal(reply.parent_comment_id, comment.id);
    id.comment = comment.id;
    const top = await u.member3.services.comments.list({ postId: id.post });
    assert.deepEqual(top.items.map((x) => [x.id, x.reply_count]), [[comment.id, 1]]);
    const replies = await u.member3.services.comments.list({ postId: id.post, parentCommentId: comment.id });
    assert.deepEqual(replies.items.map((x) => x.id), [reply.id]);
  });

  test('reactions, with one summary call for many posts', async () => {
    await u.member2.services.posts.react({ postId: id.post, type: 'like' });
    await u.member2.services.posts.react({ postId: id.post, type: 'love' }); // changes, not duplicates
    await u.member3.services.posts.react({ commentId: id.comment, type: 'celebrate' });
    const summary = await u.member2.services.posts.reactionSummary({ postIds: [id.post], commentIds: [id.comment] });
    assert.deepEqual(summary.map((s) => [s.reaction_type, s.reaction_count]).sort(), [['celebrate', 1], ['love', 1]]);
    await rejects(u.member2.services.posts.react({ postId: id.post, commentId: id.comment, type: 'like' }), ErrorCode.Validation, 'postId');
    await u.member2.services.posts.unreact({ postId: id.post });
  });

  test('edit own post; editing someone else\'s is FORBIDDEN', async () => {
    assert.equal((await u.member.services.posts.edit(id.post, 'Hello again')).body, 'Hello again');
    await rejects(u.member2.services.posts.edit(id.post, 'Vandalised'), ErrorCode.Forbidden);
    await rejects(u.admin.services.posts.edit(id.post, 'Admins cannot rewrite words either'), ErrorCode.Forbidden);
    await rejects(u.member2.services.comments.edit(id.comment, ''), ErrorCode.Validation, 'body');
  });

  test('moderate: moderators hide and restore; members cannot', async () => {
    await rejects(u.member2.services.posts.hide(id.post, 'nope'), ErrorCode.Forbidden);
    const hidden = await u.mod.services.posts.hide(id.post, 'Off topic');
    assert.deepEqual([hidden.status, hidden.moderation_reason], ['hidden', 'Off topic']);
    assert.equal((await u.member2.services.posts.list({ communityId: c.A })).items.length, 0, 'hidden posts leave the feed');
    await rejects(u.member2.services.posts.get(id.post), ErrorCode.NotFound);
    assert.equal((await u.member.services.posts.get(id.post)).moderation_reason, 'Off topic', 'the author still sees why');
    assert.equal((await u.mod.services.posts.list({ communityId: c.A, status: 'hidden' })).items.length, 1);
    await u.mod.services.posts.restore(id.post);
    assert.equal((await u.mod.services.comments.hide(id.comment, 'Spam')).status, 'hidden');
  });

  test('feed pagination: consistent pages, bounded size', async () => {
    for (let i = 0; i < 5; i += 1) await u.member3.services.posts.create({ communityId: c.A, body: `Bulk ${i}` });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await u.member2.services.posts.list({ communityId: c.A, limit: 2, cursor });
      ids.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
    await rejects(u.member2.services.posts.list({ communityId: c.A, limit: 500 }), ErrorCode.Validation, 'limit');
  });

  test('delete own post (soft)', async () => {
    assert.equal((await u.member.services.posts.delete(id.post)).status, 'deleted');
    await rejects(u.member.services.posts.edit(id.post, 'resurrect'), ErrorCode.Forbidden);
  });
});

describe('announcements', () => {
  test('create a draft, publish, retrieve', async () => {
    const draft = await u.admin.services.announcements.create({ communityId: c.A, title: 'Water shut-off', body: 'Tuesday 9–11', priority: 'important' });
    assert.equal(draft.status, 'draft');
    assert.deepEqual((await u.member.services.announcements.listCurrent({ communityId: c.A })).items, [], 'drafts are invisible to members');
    await rejects(u.member.services.announcements.get(draft.id), ErrorCode.NotFound);
    const published = await u.admin.services.announcements.publish(draft.id);
    assert.equal(published.status, 'published');
    const current = await u.member.services.announcements.listCurrent({ communityId: c.A });
    assert.deepEqual(current.items.map((a) => a.id), [draft.id]);
    assert.equal((await u.member.services.announcements.get(draft.id)).title, 'Water shut-off');
    const history = await u.member.services.announcements.listHistory({ communityId: c.A });
    assert.ok(history.items.some((a) => a.id === draft.id));
    id.announcement = draft.id;
  });

  test('members cannot create; outsiders cannot read; bad input is VALIDATION', async () => {
    await rejects(u.member.services.announcements.create({ communityId: c.A, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(u.ownerB.services.announcements.get(id.announcement), ErrorCode.NotFound);
    assert.deepEqual((await u.ownerB.services.announcements.listCurrent({ communityId: c.A })).items, []);
    // @ts-expect-error unknown priority
    await rejects(u.admin.services.announcements.create({ communityId: c.A, title: 'x', body: 'y', priority: 'urgent' }), ErrorCode.Validation, 'priority');
    await rejects(u.admin.services.announcements.create({ communityId: c.A, title: 'x', body: 'y', expiresAt: 'next week' }), ErrorCode.Validation, 'expiresAt');
  });
});

describe('alerts', () => {
  test('create, publish, retrieve', async () => {
    const draft = await u.admin.services.alerts.create({ communityId: c.A, title: 'Gas leak', body: 'Avoid building C', severity: 'urgent' });
    const published = await u.admin.services.alerts.publish(draft.id);
    assert.equal(published.status, 'published');
    const active = await u.member.services.alerts.listActive({ communityId: c.A });
    assert.deepEqual(active.items.map((a) => a.id), [draft.id]);
    assert.ok((await u.member.services.alerts.listMyActive()).some((a) => a.id === draft.id));
    assert.equal((await u.member.services.alerts.get(draft.id)).severity, 'urgent');
    id.alert = draft.id;
  });

  test('members cannot create or cancel; outsiders cannot read', async () => {
    await rejects(u.member.services.alerts.create({ communityId: c.A, title: 'x', body: 'y' }), ErrorCode.Forbidden);
    await rejects(u.member.services.alerts.cancel(id.alert, 'prank'), ErrorCode.Forbidden);
    await rejects(u.ownerB.services.alerts.get(id.alert), ErrorCode.NotFound);
    assert.deepEqual((await u.ownerB.services.alerts.listActive({ communityId: c.A })).items, []);
    const cancelled = await u.admin.services.alerts.cancel(id.alert, 'All clear');
    assert.equal(cancelled.cancellation_reason, 'All clear');
  });
});

describe('events', () => {
  test('create with capacity, RSVP, waitlist and promotion', async () => {
    const event = await u.admin.services.events.create({
      communityId: c.A, title: 'Garden day', startsAt: inOneDay(), endsAt: inOneDay(2), capacity: 2, publish: true,
    });
    id.event = event.id;
    assert.equal((await u.member.services.events.rsvp(event.id, 'going')).status, 'going');
    assert.equal((await u.member2.services.events.rsvp(event.id, 'going')).status, 'going');
    const third = await u.member3.services.events.rsvp(event.id, 'going');
    assert.equal(third.status, 'waitlisted', 'over capacity joins the waitlist');
    let attendance = await u.member3.services.events.attendance(event.id);
    assert.deepEqual([attendance.going_count, attendance.waitlisted_count, attendance.spots_left, attendance.my_waitlist_position], [2, 1, 0, 1]);
    assert.equal(await u.member.services.events.cancelRsvp(event.id), true);
    attendance = await u.member3.services.events.attendance(event.id);
    assert.deepEqual([attendance.my_status, attendance.going_count], ['going', 2], 'the waitlist is promoted');
    const upcoming = await u.member.services.events.listUpcoming({ communityId: c.A });
    assert.ok(upcoming.items.some((e) => e.id === event.id));
  });

  test('concurrent RSVPs never exceed capacity', async () => {
    const event = await u.admin.services.events.create({
      communityId: c.A, title: 'Tiny workshop', startsAt: inOneDay(3), endsAt: inOneDay(4), capacity: 1, publish: true,
    });
    const results = await Promise.all([u.member, u.member2, u.member3, u.mod].map((x) => x.services.events.rsvp(event.id, 'going')));
    assert.equal(results.filter((r) => r.status === 'going').length, 1);
    assert.equal(results.filter((r) => r.status === 'waitlisted').length, 3);
  });

  test('validation and permissions', async () => {
    await rejects(u.admin.services.events.create({ communityId: c.A, title: 'x', startsAt: inOneDay(2), endsAt: inOneDay(1) }), ErrorCode.Validation, 'endsAt');
    await rejects(u.admin.services.events.create({ communityId: c.A, title: 'x', startsAt: '2030-01-01', endsAt: inOneDay() }), ErrorCode.Validation, 'startsAt');
    await rejects(u.admin.services.events.create({ communityId: c.A, title: 'x', startsAt: inOneDay(), endsAt: inOneDay(1), capacity: 0 }), ErrorCode.Validation, 'capacity');
    await rejects(u.member.services.events.create({ communityId: c.A, title: 'x', startsAt: inOneDay(), endsAt: inOneDay(1) }), ErrorCode.Forbidden);
    // @ts-expect-error waitlisted cannot be requested
    await rejects(u.member.services.events.rsvp(id.event, 'waitlisted'), ErrorCode.Validation, 'status');
    // Another community's event answers exactly like an event that does not exist (no existence oracle).
    const foreign = await rejects(u.ownerB.services.events.rsvp(id.event, 'going'), ErrorCode.Forbidden);
    const missing = await rejects(u.ownerB.services.events.rsvp('00000000-0000-4000-8000-000000000000', 'going'), ErrorCode.Forbidden);
    assert.equal(foreign.message, missing.message);
    await rejects(u.ownerB.services.events.attendance(id.event), ErrorCode.NotFound);
  });
});

describe('notifications', () => {
  test('retrieve and mark read', async () => {
    const page = await u.member.services.notifications.list({ limit: 50 });
    const announcement = page.items.find((n) => n.type === 'announcement');
    assert.ok(announcement, 'publishing the announcement notified members');
    const before = await u.member.services.notifications.unreadCount();
    assert.equal(await u.member.services.notifications.markRead(announcement.id), true);
    assert.equal(await u.member.services.notifications.unreadCount(), before - 1);
    assert.equal(await u.member2.services.notifications.markRead(announcement.id), false, 'someone else\'s notification is invisible');
    assert.ok((await u.member.services.notifications.markAllRead()) >= 0);
    assert.equal(await u.member.services.notifications.unreadCount(), 0);
    const unread = await u.member.services.notifications.list({ unreadOnly: true });
    assert.deepEqual(unread.items, []);
  });
});

describe('documents', () => {
  test('upload and access', async () => {
    const doc = await u.admin.services.documents.upload({ communityId: c.A, name: 'Bylaws.pdf', mimeType: 'application/pdf', file: pdf('bylaws') });
    assert.equal(doc.status, 'active');
    id.doc = doc.id;
    const url = await u.member.services.documents.getDownloadUrl(doc.id, 30);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /bylaws/);
    const listed = await u.member.services.documents.list({ communityId: c.A });
    assert.deepEqual(listed.items.map((d) => d.id), [doc.id]);
  });

  test('unauthorized access is denied', async () => {
    await rejects(u.ownerB.services.documents.getDownloadUrl(id.doc), ErrorCode.NotFound);
    await rejects(u.ownerB.services.documents.get(id.doc), ErrorCode.NotFound);
    assert.deepEqual((await u.ownerB.services.documents.list({ communityId: c.A })).items, []);
    await rejects(u.member.services.documents.upload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', file: pdf('x') }), ErrorCode.Forbidden);
    await rejects(u.member.services.documents.delete(id.doc), ErrorCode.Forbidden);
    // Restricted documents are invisible to plain members.
    const restricted = await u.admin.services.documents.upload({ communityId: c.A, name: 'Board.pdf', mimeType: 'application/pdf', file: pdf('board'), visibility: 'managers' });
    await rejects(u.member.services.documents.getDownloadUrl(restricted.id), ErrorCode.NotFound);
  });

  test('file abuse: type, size, names and links are validated', async () => {
    await rejects(u.admin.services.documents.upload({ communityId: c.A, name: 'evil.exe', mimeType: 'application/x-msdownload', file: pdf('x') }), ErrorCode.Validation);
    await rejects(u.admin.services.documents.upload({ communityId: c.A, name: '../../etc/passwd', mimeType: 'application/pdf', file: pdf('x') }), ErrorCode.Validation, 'name');
    await rejects(u.admin.services.documents.upload({ communityId: c.A, name: 'empty.pdf', mimeType: 'application/pdf', file: new Uint8Array() }), ErrorCode.Validation, 'file');
    await rejects(u.admin.services.documents.getDownloadUrl(id.doc, 86_400), ErrorCode.Validation, 'expiresInSeconds');
  });

  test('delete makes the file unreachable', async () => {
    await u.admin.services.documents.delete(id.doc);
    await rejects(u.member.services.documents.getDownloadUrl(id.doc), ErrorCode.NotFound);
  });
});

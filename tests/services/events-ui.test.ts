// What the mobile event screens rely on (RN-11), against the real local
// Supabase: upcoming and past lists, the organizer's name, RSVP with
// capacity and the waitlist, RSVP changes, the lifecycle, permissions and
// isolation.
//
//   A: owner (Owner: events.manage), organizer (Member + events.create), member, member2 (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'organizer' | 'member' | 'member2' | 'other', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

/** A past event, as trusted server code would leave it (clients cannot publish an ended event). */
async function pastEvent(title: string, startsInHours: number, status: 'published' | 'cancelled' | 'completed') {
  const { data } = await admin
    .from('events')
    .insert({ community_id: c.A!, title, starts_at: inHours(startsInHours), ends_at: inHours(startsInHours + 2), status: 'draft' })
    .select('id')
    .single()
    .throwOnError();
  await admin.from('events').update({ status }).eq('id', data!.id).throwOnError();
  return data!.id;
}

before(async () => {
  u = await users('owner', 'organizer', 'member', 'member2', 'other');
  c.A = await community(u.owner, 'EventsA');
  c.B = await community(u.other, 'EventsB');
  for (const who of ['organizer', 'member', 'member2'] as const) await addMember(c.A, u[who].id, 'Member');
  const { data: role } = await admin.from('roles').insert({ community_id: c.A, name: 'Organizer' }).select('id').single().throwOnError();
  const { data: perm } = await admin.from('permissions').select('id').eq('key', 'events.create').single().throwOnError();
  await admin.from('role_permissions').insert({ role_id: role!.id, permission_id: perm!.id }).throwOnError();
  const { data: m } = await admin.from('memberships').select('id').eq('community_id', c.A).eq('user_id', u.organizer.id).single().throwOnError();
  await admin.from('membership_roles').insert({ membership_id: m!.id, role_id: role!.id }).throwOnError();
  await u.organizer.services.auth.updateMyProfile({ displayName: 'Olive Organizer' });

  id.small = (await u.organizer.services.events.create({
    communityId: c.A, title: 'Workshop', startsAt: inHours(24), endsAt: inHours(26), timezone: 'Europe/London',
    locationText: 'Hall', capacity: 1, publish: true,
  })).id;
  id.ownerEvent = (await u.owner.services.events.create({ communityId: c.A, title: 'Picnic', startsAt: inHours(48), endsAt: inHours(50), publish: true })).id;
  id.pastOld = await pastEvent('Old fair', -24 * 30, 'published');
  id.pastRecent = await pastEvent('Last week', -24 * 7, 'completed');
  id.pastCancelled = await pastEvent('Rained off', -24 * 3, 'cancelled');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('reading events', () => {
  test('upcoming soonest first; past newest first; the organizer has a name', async () => {
    const s = u.member.services.events;
    assert.deepEqual((await s.listUpcoming({ communityId: c.A! })).items.map((e) => e.title), ['Workshop', 'Picnic']);
    assert.deepEqual((await s.listPast({ communityId: c.A! })).items.map((e) => e.title), ['Rained off', 'Last week', 'Old fair']);
    const page = await s.listPast({ communityId: c.A!, limit: 1 });
    assert.deepEqual((await s.listPast({ communityId: c.A!, limit: 1, cursor: page.nextCursor })).items.map((e) => e.title), ['Last week']);
    const workshop = await s.get(id.small!);
    assert.deepEqual([workshop.timezone, workshop.location_text, workshop.capacity], ['Europe/London', 'Hall', 1]);
    assert.equal(await s.organizerName(workshop.created_by), 'Olive Organizer');
  });
});

describe('RSVP, capacity and the waitlist', () => {
  test('going until full, then waitlisted; a freed place promotes the next person', async () => {
    const a = u.member.services.events;
    const b = u.member2.services.events;
    assert.equal((await a.rsvp(id.small!, 'going')).status, 'going');
    const second = await b.rsvp(id.small!, 'going');
    assert.equal(second.status, 'waitlisted');
    assert.ok(second.waitlistedAt);
    const seen = await b.attendance(id.small!);
    assert.deepEqual(
      [seen.capacity, seen.going_count, seen.waitlisted_count, seen.spots_left, seen.my_status, seen.my_waitlist_position],
      [1, 1, 1, 0, 'waitlisted', 1],
    );
    // A change of answer frees the place; the waitlist is promoted in the same transaction.
    assert.equal((await a.rsvp(id.small!, 'maybe')).status, 'maybe');
    assert.equal((await b.attendance(id.small!)).my_status, 'going');
    assert.equal((await a.attendance(id.small!)).maybe_count, 1);
    // Back to going: the event is full again, so the first member now waits.
    assert.equal((await a.rsvp(id.small!, 'going')).status, 'waitlisted');
    assert.equal(await a.cancelRsvp(id.small!), true);
    assert.equal((await a.attendance(id.small!)).my_status, null);
  });

  test('raising capacity admits more; it cannot drop below the number going', async () => {
    // Now: member2 going (1 of 1).
    await u.organizer.services.events.edit(id.small!, { capacity: 2 });
    assert.equal((await u.member.services.events.rsvp(id.small!, 'going')).status, 'going');
    assert.equal((await u.member.services.events.attendance(id.small!)).spots_left, 0);
    await rejects(u.organizer.services.events.edit(id.small!, { capacity: 1 }), ErrorCode.Validation);
  });
});

describe('managing events', () => {
  test('members cannot create; organizers manage only their own; cancel freezes RSVPs', async () => {
    await rejects(
      u.member.services.events.create({ communityId: c.A!, title: 'x', startsAt: inHours(5), endsAt: inHours(6) }),
      ErrorCode.Forbidden,
    );
    await rejects(u.organizer.services.events.cancel(id.ownerEvent!, 'not mine'), ErrorCode.Forbidden);
    const draft = await u.organizer.services.events.create({ communityId: c.A!, title: 'Draft talk', startsAt: inHours(72), endsAt: inHours(73) });
    assert.equal(draft.status, 'draft');
    assert.ok(!(await u.member.services.events.listUpcoming({ communityId: c.A! })).items.some((e) => e.id === draft.id));
    assert.equal((await u.organizer.services.events.publish(draft.id)).status, 'published');
    await rejects(u.organizer.services.events.complete(draft.id), ErrorCode.Validation); // not started yet
    const cancelled = await u.organizer.services.events.cancel(draft.id, 'Speaker ill');
    assert.deepEqual([cancelled.status, cancelled.cancellation_reason], ['cancelled', 'Speaker ill']);
    await rejects(u.member.services.events.rsvp(draft.id, 'going'), ErrorCode.Forbidden);
    await rejects(u.organizer.services.events.edit(draft.id, { title: 'Again' }), ErrorCode.Forbidden);
  });

  test('another community: nothing visible, nothing allowed', async () => {
    const s = u.other.services.events;
    assert.deepEqual((await s.listUpcoming({ communityId: c.A! })).items, []);
    assert.deepEqual((await s.listPast({ communityId: c.A! })).items, []);
    await rejects(s.get(id.small!), ErrorCode.NotFound);
    await rejects(s.rsvp(id.small!, 'going'), ErrorCode.Forbidden);
    await rejects(s.cancel(id.ownerEvent!), ErrorCode.NotFound);
    assert.equal(await s.organizerName((await u.member.services.events.get(id.small!)).created_by), null);
  });
});

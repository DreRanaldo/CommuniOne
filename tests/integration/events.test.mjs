// Stage 8: events and RSVPs through the real Data API, including truly
// concurrent RSVPs over separate PostgREST connections.
//
//   Community A                               Community B
//     ownerA   Owner (events.view/create/manage) ownerB  Owner
//     memberA  Member (events.view)
//     crowd[]  25 Members (concurrency test)
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

const CROWD = 25;
const CAPACITY = 10;

after(async () => {
  // events.created_by is ON DELETE RESTRICT: remove events before their creators.
  for (const id of Object.values(c)) await admin.from('events').delete().eq('community_id', id);
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const ev = {};
const crowd = [];

const inDays = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
const rsvpOf = async (userId, eventId) =>
  (await admin.from('event_rsvps').select('status').eq('user_id', userId).eq('event_id', eventId).maybeSingle()).data?.status;

before(async () => {
  for (const name of ['ownerA', 'memberA', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Events ${key}`,
      p_slug: `events-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.memberA.id, 'Member');
  for (let i = 0; i < CROWD; i += 1) {
    const user = await createConfirmedUser(`crowd${i}`);
    await addMember(c.A, user.id, 'Member');
    crowd.push({ ...user, client: (await signIn(user.email)).client });
  }
});

describe('event management', () => {
  test('1. an authorized user creates a draft event', async () => {
    const { data, error } = await u.ownerA.client.from('events').insert({
      community_id: c.A, title: 'Summer BBQ', starts_at: inDays(10), ends_at: inDays(10, 3), timezone: 'America/Chicago',
    }).select('id, status, created_by').single();
    assert.equal(error, null);
    assert.deepEqual([data.status, data.created_by], ['draft', u.ownerA.id]);
    ev.bbq = data.id;
  });

  test('2. a normal member cannot create an event, in her community or another', async () => {
    const own = await u.memberA.client.from('events').insert({ community_id: c.A, title: 'x', starts_at: inDays(1), ends_at: inDays(1, 1) });
    assert.equal(own.error?.code, '42501');
    const other = await u.ownerB.client.from('events').insert({ community_id: c.A, title: 'x', starts_at: inDays(1), ends_at: inDays(1, 1) });
    assert.equal(other.error?.code, '42501');
  });

  test('invalid times are rejected', async () => {
    const { error } = await u.ownerA.client.from('events').insert({ community_id: c.A, title: 'x', starts_at: inDays(2), ends_at: inDays(1) });
    assert.equal(error?.code, '23514');
  });

  test('4. drafts are hidden from members until published', async () => {
    assert.deepEqual((await u.memberA.client.from('events').select('id').eq('id', ev.bbq)).data, []);
    const { data } = await u.ownerA.client.from('events').update({ status: 'published' }).eq('id', ev.bbq).select('status, published_at');
    assert.equal(data[0].status, 'published');
    assert.ok(data[0].published_at);
    const { data: upcoming } = await u.memberA.client.rpc('list_upcoming_events', { p_community_id: c.A });
    assert.deepEqual(upcoming.map((e) => e.id), [ev.bbq]);
  });

  test('3. the organizer edits the event; members cannot', async () => {
    const { data } = await u.ownerA.client.from('events').update({ location_text: 'Pavilion' }).eq('id', ev.bbq).select('location_text, edited_at');
    assert.equal(data[0].location_text, 'Pavilion');
    assert.ok(data[0].edited_at);
    assert.deepEqual((await u.memberA.client.from('events').update({ title: 'Hacked' }).eq('id', ev.bbq).select()).data, []);
    assert.deepEqual((await u.ownerB.client.from('events').update({ title: 'Hacked' }).eq('id', ev.bbq).select()).data, []);
  });
});

describe('RSVPs', () => {
  test('6. a member RSVPs and sees the attendance', async () => {
    const { data, error } = await u.memberA.client.rpc('rsvp_to_event', { p_event_id: ev.bbq, p_status: 'going' });
    assert.equal(error, null);
    assert.equal(data[0].status, 'going');
    const { data: attendance } = await u.memberA.client.rpc('get_event_attendance', { p_event_id: ev.bbq });
    assert.equal(attendance[0].going_count, 1);
    assert.equal(attendance[0].my_status, 'going');
  });

  test('7. a member changes and cancels her RSVP', async () => {
    const { data } = await u.memberA.client.rpc('rsvp_to_event', { p_event_id: ev.bbq, p_status: 'maybe' });
    assert.equal(data[0].status, 'maybe');
    const { data: cancelled, error } = await u.memberA.client.rpc('cancel_rsvp', { p_event_id: ev.bbq });
    assert.equal(error, null);
    assert.equal(cancelled, true);
    assert.equal(await rsvpOf(u.memberA.id, ev.bbq), undefined);
  });

  test('9. duplicate RSVPs are prevented', async () => {
    await u.memberA.client.rpc('rsvp_to_event', { p_event_id: ev.bbq, p_status: 'going' }).throwOnError();
    const { error } = await u.memberA.client.from('event_rsvps').insert({ event_id: ev.bbq, status: 'going' });
    assert.equal(error?.code, '23505');
  });

  test('8. a member cannot RSVP to another community\'s event', async () => {
    const { error } = await u.ownerB.client.rpc('rsvp_to_event', { p_event_id: ev.bbq, p_status: 'going' });
    assert.equal(error?.code, '42501');
  });

  test('a member cannot modify, cancel or create someone else\'s RSVP', async () => {
    const victim = crowd[0];
    await victim.client.rpc('rsvp_to_event', { p_event_id: ev.bbq, p_status: 'going' }).throwOnError();
    const { data: rows } = await admin.from('event_rsvps').select('id').eq('user_id', victim.id).eq('event_id', ev.bbq).single();
    assert.deepEqual((await u.memberA.client.from('event_rsvps').update({ status: 'not_going' }).eq('id', rows.id).select()).data, []);
    assert.deepEqual((await u.memberA.client.from('event_rsvps').delete().eq('id', rows.id).select()).data, []);
    const spoof = await u.memberA.client.from('event_rsvps').insert({ event_id: ev.bbq, status: 'going', user_id: crowd[1].id });
    assert.equal(spoof.error?.code, '42501');
    assert.equal(await rsvpOf(victim.id, ev.bbq), 'going');
    await victim.client.from('event_rsvps').delete().eq('id', rows.id).throwOnError();
  });
});

describe('capacity, concurrency and waitlist', () => {
  test('11. concurrent RSVPs never overbook: exactly CAPACITY going, the rest waitlisted', async () => {
    const { data } = await u.ownerA.client.from('events').insert({
      community_id: c.A, title: 'Workshop', starts_at: inDays(5), ends_at: inDays(5, 2), capacity: CAPACITY, status: 'published',
    }).select('id').single();
    ev.workshop = data.id;

    // Fire every RSVP at once: separate HTTP requests, separate DB connections.
    const results = await Promise.all(
      crowd.map((member) => member.client.rpc('rsvp_to_event', { p_event_id: ev.workshop, p_status: 'going' })),
    );
    for (const r of results) assert.equal(r.error, null);

    const statuses = results.map((r) => r.data[0].status);
    assert.equal(statuses.filter((s) => s === 'going').length, CAPACITY, 'exactly CAPACITY going');
    assert.equal(statuses.filter((s) => s === 'waitlisted').length, CROWD - CAPACITY, 'everyone else waitlisted');

    const { data: stored } = await admin.from('event_rsvps').select('status').eq('event_id', ev.workshop);
    assert.equal(stored.filter((r) => r.status === 'going').length, CAPACITY, 'the database agrees');
  });

  test('12. the waitlist is first-come-first-served and promotes on cancellation', async () => {
    const { data: queue } = await admin
      .from('event_rsvps').select('user_id, waitlisted_at').eq('event_id', ev.workshop).eq('status', 'waitlisted')
      .order('waitlisted_at').order('id');
    const first = queue[0].user_id;
    const second = queue[1].user_id;

    const firstMember = crowd.find((m) => m.id === first);
    const { data: position } = await firstMember.client.rpc('get_event_attendance', { p_event_id: ev.workshop });
    assert.equal(position[0].my_waitlist_position, 1);

    const { data: goingRows } = await admin.from('event_rsvps').select('user_id').eq('event_id', ev.workshop).eq('status', 'going').limit(1);
    const leaver = crowd.find((m) => m.id === goingRows[0].user_id);
    await leaver.client.rpc('cancel_rsvp', { p_event_id: ev.workshop }).throwOnError();

    assert.equal(await rsvpOf(first, ev.workshop), 'going', 'first in line promoted');
    assert.equal(await rsvpOf(second, ev.workshop), 'waitlisted', 'second still waiting');
  });

  test('10. capacity cannot be bypassed or lowered below attendance', async () => {
    const waiting = (await admin.from('event_rsvps').select('user_id').eq('event_id', ev.workshop).eq('status', 'waitlisted').limit(1)).data[0];
    const member = crowd.find((m) => m.id === waiting.user_id);
    await member.client.from('event_rsvps').update({ status: 'going' }).eq('event_id', ev.workshop).throwOnError();
    assert.equal(await rsvpOf(member.id, ev.workshop), 'waitlisted', 'asking again does not jump the queue');
    const queueJump = await member.client.from('event_rsvps').update({ waitlisted_at: '2000-01-01T00:00:00Z' }).eq('event_id', ev.workshop);
    assert.equal(queueJump.error?.code, '42501');
    const lower = await u.ownerA.client.from('events').update({ capacity: 2 }).eq('id', ev.workshop);
    assert.equal(lower.error?.code, '22023');
  });

  test('12. raising the capacity promotes from the waitlist', async () => {
    await u.ownerA.client.from('events').update({ capacity: CAPACITY + 5 }).eq('id', ev.workshop).throwOnError();
    const { data } = await u.memberA.client.rpc('get_event_attendance', { p_event_id: ev.workshop });
    // 25 RSVPs - 1 who left = 24: 15 going after the increase, 9 still waiting.
    assert.equal(data[0].going_count, CAPACITY + 5);
    assert.equal(data[0].waitlisted_count, CROWD - 1 - (CAPACITY + 5));
    assert.equal(data[0].spots_left, 0);
  });
});

describe('cancellation and isolation', () => {
  test('5. cancelling an event freezes RSVPs', async () => {
    const { data } = await u.ownerA.client.from('events').update({ status: 'cancelled', cancellation_reason: 'Venue flooded' }).eq('id', ev.workshop).select('status, cancelled_by');
    assert.deepEqual(data, [{ status: 'cancelled', cancelled_by: u.ownerA.id }]);
    const { error } = await crowd[0].client.rpc('rsvp_to_event', { p_event_id: ev.workshop, p_status: 'going' });
    assert.equal(error?.code, '42501');
    const reopen = await u.ownerA.client.from('events').update({ status: 'published' }).eq('id', ev.workshop);
    assert.equal(reopen.error?.code, '42501');
  });

  test('13. another community sees nothing of A\'s events, attendance or RSVPs', async () => {
    const client = u.ownerB.client;
    assert.deepEqual((await client.from('events').select('id').eq('id', ev.bbq)).data, []);
    assert.deepEqual((await client.from('events').select('id').eq('community_id', c.A)).data, []);
    assert.deepEqual((await client.rpc('list_upcoming_events', { p_community_id: c.A })).data, []);
    assert.deepEqual((await client.rpc('list_events', { p_community_id: c.A })).data, []);
    assert.deepEqual((await client.rpc('get_event_attendance', { p_event_id: ev.bbq })).data, []);
    assert.deepEqual((await client.from('event_rsvps').select('id').eq('event_id', ev.bbq)).data, []);
  });
});

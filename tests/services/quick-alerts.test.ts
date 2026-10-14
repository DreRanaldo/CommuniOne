// Quick alerts (migration 31) against the real local Supabase: members send
// alerts at once (not emergencies), with an optional location and a photo in
// the private alert-images bucket; the community is notified; outsiders never
// see the position or the photo; only managers take alerts down.
//
//   A: owner (Owner), member (Member), neighbour (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'member' | 'neighbour' | 'other', TestUser>;
const c: Record<string, string> = {};
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => i % 256), 0xff, 0xd9]);

before(async () => {
  u = await users('owner', 'member', 'neighbour', 'other');
  c.A = await community(u.owner, 'QuickA');
  c.B = await community(u.other, 'QuickB');
  await addMember(c.A, u.member.id, 'Member');
  await addMember(c.A, u.neighbour.id, 'Member');
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('quick alerts', () => {
  let alertId = '';

  test('a member sends an urgent alert with location and photo; neighbours are notified', async () => {
    const alert = await u.member.services.alerts.create({
      communityId: c.A!, title: 'Break-in or theft', body: 'Back door forced at no. 4', severity: 'urgent', publish: true,
      location: { latitude: 51.5013641, longitude: -0.1418899, accuracy: 12.4 },
      image: { file: jpeg(), mimeType: 'image/jpeg' },
    });
    alertId = alert.id;
    assert.equal(alert.status, 'published');
    assert.equal(alert.latitude, 51.50136);
    assert.equal(alert.longitude, -0.14189);
    assert.equal(alert.location_accuracy_m, 12);
    assert.match(alert.image_path ?? '', new RegExp(`^${c.A}/${u.member.id}/[0-9a-f-]{36}\\.jpg$`));

    const seen = await u.neighbour.services.alerts.get(alert.id);
    assert.equal(seen.latitude, 51.50136);
    const url = await u.neighbour.services.alerts.imageUrl(seen);
    assert.ok(url, 'members of the community get a signed link to the photo');
    assert.equal((await (await fetch(url!)).arrayBuffer()).byteLength, jpeg().byteLength);

    const inbox = (await u.neighbour.services.notifications.list({ limit: 20 })).items;
    assert.ok(inbox.some((n) => n.type === 'alert' && /Break-in/.test(n.title ?? '')), 'neighbours are notified');
  });

  test('outsiders see neither the alert, its position nor its photo', async () => {
    await rejects(u.other.services.alerts.get(alertId), ErrorCode.NotFound);
    const path = (await u.owner.services.alerts.get(alertId)).image_path;
    assert.equal(await u.other.services.alerts.imageUrl({ image_path: path }), null);
  });

  test('members cannot send emergencies, attach others’ photos, or take alerts down', async () => {
    await rejects(u.member.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y', severity: 'emergency', publish: true }), ErrorCode.Forbidden);
    const path = (await u.owner.services.alerts.get(alertId)).image_path!;
    const { error } = await u.neighbour.client.from('alerts').insert({ community_id: c.A!, title: 'x', body: 'y', image_path: path } as never);
    assert.ok(error, 'someone else’s photo is refused');
    await rejects(u.member.services.alerts.cancel(alertId), ErrorCode.Forbidden);
    await rejects(u.member.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y', location: { latitude: 0, longitude: 200 } }), ErrorCode.Validation);
    assert.equal((await u.owner.services.alerts.cancel(alertId, 'Police informed')).status, 'cancelled');
  });

  test('an outsider cannot send into the community or upload into its folder', async () => {
    await rejects(u.other.services.alerts.create({ communityId: c.A!, title: 'x', body: 'y', image: { file: jpeg(), mimeType: 'image/jpeg' } }), ErrorCode.Forbidden);
  });
});

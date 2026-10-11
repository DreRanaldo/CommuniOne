// Pre-Stage 12: phone numbers are private to their owner, through the real Data API.
//
//   Community A
//     ownerA   Owner (every community permission)
//     memberA  Member; owns a phone number
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, anonClient, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from './helpers.mjs';

after(deleteTrackedUsers);

const u = {};
const c = {};
const PHONE = '+44 20 7946 0000';

before(async () => {
  for (const name of ['ownerA', 'memberA']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  const { data, error } = await u.ownerA.client.rpc('create_community', {
    p_name: 'Privacy A', p_slug: `privacy-a-${u.ownerA.id.slice(0, 8)}`,
  });
  if (error) throw error;
  trackCommunity(data.id);
  c.A = data.id;
  await addMember(c.A, u.memberA.id, 'Member');
});

describe('owner access', () => {
  test('a user stores and reads their own phone number', async () => {
    await u.memberA.client.from('profile_private').insert({ phone: PHONE }).throwOnError();
    const { data } = await u.memberA.client.from('profile_private').select('user_id, phone');
    assert.deepEqual(data, [{ user_id: u.memberA.id, phone: PHONE }]);
  });

  test('a user updates and clears their phone number', async () => {
    await u.memberA.client.from('profile_private').update({ phone: '+44 20 7946 0001' }).eq('user_id', u.memberA.id).throwOnError();
    assert.equal((await admin.from('profile_private').select('phone').eq('user_id', u.memberA.id).single()).data.phone, '+44 20 7946 0001');
    await u.memberA.client.from('profile_private').update({ phone: PHONE }).eq('user_id', u.memberA.id).throwOnError();
  });

  test('nobody can write a phone number for someone else', async () => {
    const forged = await u.ownerA.client.from('profile_private').insert({ user_id: u.memberA.id, phone: '+1 555 0199' });
    assert.equal(forged.error?.code, '42501');
    const { data } = await u.ownerA.client.from('profile_private').update({ phone: '+1 555 0199' }).eq('user_id', u.memberA.id).select();
    assert.deepEqual(data, []);
    assert.equal((await admin.from('profile_private').select('phone').eq('user_id', u.memberA.id).single()).data.phone, PHONE);
  });
});

describe('nobody else can read it', () => {
  test('the community Owner cannot read a member\'s phone number', async () => {
    assert.deepEqual((await u.ownerA.client.from('profile_private').select('phone').eq('user_id', u.memberA.id)).data, []);
  });

  test('profiles no longer carry a phone column', async () => {
    const { error } = await u.ownerA.client.from('profiles').select('phone').eq('id', u.memberA.id);
    assert.equal(error?.code, '42703');
    const { data } = await u.ownerA.client.from('profiles').select('*').eq('id', u.memberA.id).single();
    assert.ok(data, 'co-members still see the profile');
    assert.ok(!JSON.stringify(data).includes(PHONE.slice(4)));
  });

  test('embedding private details in a profile query returns nothing for other users', async () => {
    const { data, error } = await u.ownerA.client.from('profiles').select('id, profile_private(phone)').eq('id', u.memberA.id).single();
    assert.equal(error, null);
    assert.ok(data.profile_private === null || (Array.isArray(data.profile_private) && data.profile_private.length === 0), JSON.stringify(data));
  });

  test('signed-out clients cannot read phone numbers', async () => {
    const { data, error } = await anonClient().from('profile_private').select('phone');
    assert.ok(error || data.length === 0);
  });
});

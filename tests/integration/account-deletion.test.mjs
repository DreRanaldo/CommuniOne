// Pre-Stage 12: self-service account deletion through the real Auth + Data API.
//
//   Community A
//     ownerA   Owner (sole role manager)
//     leaver   Member; posts, comments, has a phone number; deletes their account
//     memberA  Member; checks that history survives
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, rest, signIn, trackCommunity } from './helpers.mjs';

after(async () => {
  for (const id of Object.values(c)) await admin.from('posts').delete().eq('community_id', id);
  await deleteTrackedUsers();
});

const u = {};
const c = {};
const content = {};

before(async () => {
  for (const name of ['ownerA', 'leaver', 'memberA', 'bystander']) {
    const user = await createConfirmedUser(name.toLowerCase());
    const { client, session } = await signIn(user.email);
    u[name] = { ...user, client, session };
  }
  const { data, error } = await u.ownerA.client.rpc('create_community', {
    p_name: 'Deletion A', p_slug: `deletion-a-${u.ownerA.id.slice(0, 8)}`,
  });
  if (error) throw error;
  trackCommunity(data.id);
  c.A = data.id;
  await addMember(c.A, u.leaver.id, 'Member');
  await addMember(c.A, u.memberA.id, 'Member');

  const { data: post } = await u.leaver.client.from('posts').insert({ community_id: c.A, body: 'History matters' }).select('id').single().throwOnError();
  content.post = post.id;
  const { data: comment } = await u.leaver.client.from('comments').insert({ post_id: post.id, body: 'So does this' }).select('id').single().throwOnError();
  content.comment = comment.id;
  await u.leaver.client.from('profile_private').insert({ phone: '+1 555 0100' }).throwOnError();
});

describe('safety', () => {
  test('the function only ever deletes the caller: it accepts no user id', async () => {
    const { error } = await u.bystander.client.rpc('delete_my_account', { p_user_id: u.leaver.id });
    assert.ok(error, 'a user id argument is rejected');
    const { data } = await admin.auth.admin.getUserById(u.leaver.id);
    assert.equal(data.user?.id, u.leaver.id, 'the target account still exists');
  });

  test('signed-out clients cannot delete anything', async () => {
    const { status } = await rest('rpc/delete_my_account', { method: 'POST', body: {} });
    assert.ok(status === 401 || status === 403, `status ${status}`);
  });

  test('the sole manager of a community with other members is told to transfer ownership first', async () => {
    const { error } = await u.ownerA.client.rpc('delete_my_account');
    assert.equal(error?.code, '55000');
    assert.match(error.message, /Deletion A/);
    const { data } = await admin.from('profiles').select('id').eq('id', u.ownerA.id);
    assert.equal(data.length, 1, 'nothing was deleted');
  });
});

describe('deleting an account', () => {
  test('a member deletes their own account', async () => {
    const { error } = await u.leaver.client.rpc('delete_my_account');
    assert.equal(error, null);
  });

  test('the auth account, profile, private details and memberships are gone', async () => {
    const { data: authUser } = await admin.auth.admin.getUserById(u.leaver.id);
    assert.equal(authUser.user ?? null, null);
    assert.deepEqual((await admin.from('profiles').select('id').eq('id', u.leaver.id)).data, []);
    assert.deepEqual((await admin.from('profile_private').select('user_id').eq('user_id', u.leaver.id)).data, []);
    assert.deepEqual((await admin.from('memberships').select('id').eq('user_id', u.leaver.id)).data, []);
  });

  test('the old access token no longer works', async () => {
    const { error } = await admin.auth.getUser(u.leaver.session.access_token);
    assert.ok(error, 'Auth rejects the token');
    const { data } = await u.leaver.client.from('posts').select('id').eq('community_id', c.A);
    assert.deepEqual(data ?? [], [], 'the Data API shows nothing to the old token');
  });

  test('the user can no longer sign in', async () => {
    await assert.rejects(signIn(u.leaver.email));
  });

  test('their posts and comments remain, attributed to a deleted user', async () => {
    const { data: post } = await u.memberA.client.from('posts').select('id, body, author_user_id').eq('id', content.post).single();
    assert.deepEqual(post, { id: content.post, body: 'History matters', author_user_id: null });
    const { data: comment } = await u.memberA.client.from('comments').select('body, author_user_id').eq('id', content.comment).single();
    assert.deepEqual(comment, { body: 'So does this', author_user_id: null });
  });

  test('the deletion is audited without personal data', async () => {
    const { data } = await admin.from('audit_logs').select('community_id, actor_user_id, metadata').eq('action', 'account.deleted').eq('entity_id', u.leaver.id);
    assert.equal(data.length, 1);
    assert.equal(data[0].community_id, null);
    assert.deepEqual(data[0].metadata, {});
    assert.ok(!JSON.stringify(data).includes(u.leaver.email));
  });

  test('the remaining Owner can now be deleted once ownership is not needed by others', async () => {
    // Remove the other member: ownerA becomes the last active member, so
    // the community is archived rather than blocking deletion.
    await admin.from('memberships').delete().eq('community_id', c.A).eq('user_id', u.memberA.id).throwOnError();
    const { error } = await u.ownerA.client.rpc('delete_my_account');
    assert.equal(error, null);
    const { data } = await admin.from('communities').select('status, created_by').eq('id', c.A).single();
    assert.deepEqual(data, { status: 'archived', created_by: null });
  });
});

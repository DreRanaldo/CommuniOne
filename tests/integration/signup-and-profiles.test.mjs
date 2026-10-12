// Account creation -> profile mapping, and profile ownership, end to end.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD,
  SUPABASE_URL,
  admin,
  anonClient,
  createConfirmedUser,
  deleteTrackedUsers,
  latestEmailHtml,
  signIn,
  trackUser,
  uniqueEmail,
} from './helpers.mjs';

after(deleteTrackedUsers);

const profileCount = async () => {
  const { count, error } = await admin.from('profiles').select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count;
};

describe('sign-up creates exactly one correct profile', () => {
  const email = uniqueEmail('signup');
  let userId;

  test('email sign-up creates the user and a profile from the sign-up metadata', async () => {
    const before = await profileCount();
    const { data, error } = await anonClient().auth.signUp({
      email,
      password: PASSWORD,
      options: { data: { first_name: '  Ada ', last_name: 'Lovelace', display_name: 'Ada L', avatar_url: 'http://insecure.example.test/a.png' } },
    });
    assert.equal(error, null);
    userId = data.user.id;
    trackUser(userId);

    assert.equal(data.session, null, 'no session is issued before the email is confirmed');
    assert.equal(await profileCount(), before + 1);

    const { data: profile } = await admin.from('profiles').select('*').eq('id', userId).single();
    assert.equal(profile.id, userId, 'profile id is the auth user id');
    assert.equal(profile.first_name, 'Ada');
    assert.equal(profile.last_name, 'Lovelace');
    assert.equal(profile.display_name, 'Ada L');
    assert.equal(profile.avatar_url, null, 'non-https avatar from metadata is dropped');
    assert.equal(profile.status, 'active');
    assert.ok(!('email' in profile), 'profiles hold no credentials or email');
  });

  test('an unconfirmed account cannot sign in', async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
    assert.equal(data.session, null);
    assert.equal(error?.code, 'email_not_confirmed');
  });

  test('confirming the email link activates the account without creating another profile', async () => {
    const before = await profileCount();
    const html = await latestEmailHtml(email);
    const link = html.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(link?.startsWith(SUPABASE_URL), 'confirmation email contains a verify link');

    const response = await fetch(link, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /access_token=/);

    const { session } = await signIn(email);
    assert.equal(session.user.id, userId);
    assert.equal(await profileCount(), before);
  });

  test('signing up again with the same email does not create a second user or profile', async () => {
    const before = await profileCount();
    const { data } = await anonClient().auth.signUp({ email, password: 'Another-pass-2' });
    assert.equal(data.session, null, 'no session is issued for an existing email');
    assert.equal(await profileCount(), before);

    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    assert.equal(/** @type {{ email?: string }[]} */ (users.users).filter((u) => u.email === email).length, 1, 'still exactly one auth user');
    const { data: profiles } = await admin.from('profiles').select('id').eq('id', userId);
    assert.equal(profiles.length, 1, 'still exactly one profile');
  });

  test('signing in again does not create or change the profile', async () => {
    const before = await profileCount();
    await signIn(email);
    assert.equal(await profileCount(), before);
  });

  test('weak passwords are rejected by Supabase Auth', async () => {
    const { error } = await anonClient().auth.signUp({ email: uniqueEmail('weak'), password: 'short' });
    assert.equal(error?.code, 'weak_password');
  });

  test('deleting the account deletes the profile', async () => {
    const { id } = await createConfirmedUser('deleted');
    await admin.auth.admin.deleteUser(id);
    const { data } = await admin.from('profiles').select('id').eq('id', id);
    assert.deepEqual(data, []);
  });
});

describe('profile ownership', () => {
  test('a user can read and update their own profile', async () => {
    const me = await createConfirmedUser('owner', { display_name: 'Before' });
    const { client } = await signIn(me.email);

    const { data: own, error } = await client.from('profiles').select('id, display_name').eq('id', me.id).single();
    assert.equal(error, null);
    assert.equal(own.display_name, 'Before');

    const { data: updated, error: updateError } = await client
      .from('profiles')
      .update({ display_name: '  After  ', bio: 'Hello' })
      .eq('id', me.id)
      .select('display_name, bio');
    assert.equal(updateError, null);
    assert.deepEqual(updated, [{ display_name: 'After', bio: 'Hello' }]);
  });

  test('a user cannot read or update another user\'s profile', async () => {
    const me = await createConfirmedUser('attacker');
    const victim = await createConfirmedUser('victim', { display_name: 'Victim' });
    const { client } = await signIn(me.email);

    const { data: seen } = await client.from('profiles').select('id').eq('id', victim.id);
    assert.deepEqual(seen, [], 'unrelated profiles are invisible');

    const { data: updated, error } = await client
      .from('profiles')
      .update({ display_name: 'Hacked' })
      .eq('id', victim.id)
      .select();
    assert.equal(error, null);
    assert.deepEqual(updated, [], 'no rows updated');

    const { data: victimProfile } = await admin.from('profiles').select('display_name').eq('id', victim.id).single();
    assert.equal(victimProfile.display_name, 'Victim');
  });

  test('a co-member (even the community Owner) can see but not update a member\'s profile', async () => {
    const owner = await createConfirmedUser('community-owner');
    const member = await createConfirmedUser('community-member', { display_name: 'Member' });
    const { client: ownerClient } = await signIn(owner.email);

    const { data: community, error } = await ownerClient.rpc('create_community', {
      p_name: 'Shared',
      p_slug: `shared-${owner.id.slice(0, 8)}`,
    });
    assert.equal(error, null);
    // Add the member as a trusted backend would (invitations arrive in a later stage).
    await admin.from('memberships').insert({ community_id: community.id, user_id: member.id, status: 'active' }).throwOnError();

    const { data: visible } = await ownerClient.from('profiles').select('display_name').eq('id', member.id);
    assert.deepEqual(visible, [{ display_name: 'Member' }], 'co-member profile is visible');

    const { data: updated, error: updateError } = await ownerClient
      .from('profiles')
      .update({ display_name: 'Renamed by owner' })
      .eq('id', member.id)
      .select();
    assert.equal(updateError, null);
    assert.deepEqual(updated, [], 'community permissions never grant profile edits');

    await admin.from('membership_roles').delete().eq('community_id', community.id).throwOnError();
    await admin.from('memberships').delete().eq('community_id', community.id).throwOnError();
    await admin.from('roles').delete().eq('community_id', community.id).throwOnError();
    await admin.from('communities').delete().eq('id', community.id).throwOnError();
  });

  test('a user cannot change their own account status or create profiles', async () => {
    const me = await createConfirmedUser('status');
    const { client } = await signIn(me.email);

    const { error: statusError } = await client.from('profiles').update({ status: 'active' }).eq('id', me.id);
    assert.equal(statusError?.code, '42501');

    const { error: insertError } = await client.from('profiles').insert({ id: crypto.randomUUID() });
    assert.equal(insertError?.code, '42501');
  });

  test('a platform admin can update another user\'s profile and suspend the account', async () => {
    const platformAdmin = await createConfirmedUser('platform-admin');
    const member = await createConfirmedUser('member', { display_name: 'Member' });
    await admin.from('platform_admins').insert({ user_id: platformAdmin.id }).throwOnError();

    const { client: adminClient } = await signIn(platformAdmin.email);
    const { client: memberClient } = await signIn(member.email);

    const { data: updated } = await adminClient
      .from('profiles')
      .update({ display_name: 'Member (verified)' })
      .eq('id', member.id)
      .select('display_name');
    assert.deepEqual(updated, [{ display_name: 'Member (verified)' }]);

    const { data: before, error: createError } = await memberClient.rpc('create_community', {
      p_name: 'Before Suspension',
      p_slug: `before-${member.id.slice(0, 8)}`,
    });
    assert.equal(createError, null);
    assert.ok(before.id);

    const { data: suspended, error: suspendError } = await adminClient.rpc('admin_set_account_status', {
      p_user_id: member.id,
      p_status: 'suspended',
    });
    assert.equal(suspendError, null);
    assert.equal(suspended.status, 'suspended');

    // The member's token is still cryptographically valid and Supabase Auth
    // still accepts it, but the database no longer treats it as authorized.
    const { error: getUserError } = await memberClient.auth.getUser();
    assert.equal(getUserError, null, 'Supabase Auth still recognises the session');

    const { error: blocked } = await memberClient.rpc('create_community', {
      p_name: 'After Suspension',
      p_slug: `after-${member.id.slice(0, 8)}`,
    });
    assert.equal(blocked?.code, '42501', 'suspended account cannot act');

    const { data: communities } = await memberClient.from('communities').select('id');
    assert.deepEqual(communities, [], 'suspended account cannot read its communities');

    const { data: ownProfile } = await memberClient.from('profiles').select('status').eq('id', member.id).single();
    assert.equal(ownProfile.status, 'suspended', 'suspended user can still see why');

    // Clean up the community created above (communities RESTRICT deletes).
    await admin.from('membership_roles').delete().eq('community_id', before.id).throwOnError();
    await admin.from('memberships').delete().eq('community_id', before.id).throwOnError();
    await admin.from('roles').delete().eq('community_id', before.id).throwOnError();
    await admin.from('communities').delete().eq('id', before.id).throwOnError();
  });

  test('a regular user cannot use the admin path', async () => {
    const me = await createConfirmedUser('not-admin');
    const other = await createConfirmedUser('other');
    const { client } = await signIn(me.email);

    const { error } = await client.rpc('admin_set_account_status', { p_user_id: other.id, p_status: 'suspended' });
    assert.equal(error?.code, '42501');

    const { error: grantError } = await client.from('platform_admins').insert({ user_id: me.id });
    assert.equal(grantError?.code, '42501');
  });
});

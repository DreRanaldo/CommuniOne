// Service layer: the user's own profile, private phone number, avatar
// (private bucket, signed URLs), account info, password change and account
// deletion, against the real local Supabase (Auth, Data API, Storage).
//
//   Community A: owner (Owner), me (Member), coMember (Member)
//   outsider: no shared community
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';
import { signIn } from '../integration/helpers.mjs';

let u: Record<'owner' | 'me' | 'coMember' | 'outsider', TestUser>;
const c: Record<string, string> = {};

// A few bytes are enough: Storage checks the declared type and the size.
const jpeg = (size = 64) => new Uint8Array(size).fill(0xff);

before(async () => {
  u = await users('owner', 'me', 'coMember', 'outsider');
  c.A = await community(u.owner, 'Profile');
  await addMember(c.A, u.me.id, 'Member');
  await addMember(c.A, u.coMember.id, 'Member');
});
after(async () => {
  const { data } = await admin.storage.from('avatars').list(u.me.id);
  if (data?.length) await admin.storage.from('avatars').remove(data.map((f) => `${u.me.id}/${f.name}`));
  await cleanupCommunityContent(Object.values(c));
});

describe('profile', () => {
  test('loads the caller\'s own profile', async () => {
    const profile = await u.me.services.auth.getMyProfile();
    assert.equal(profile.id, u.me.id);
    assert.equal(profile.avatar_path, null);
  });

  test('edits are validated and saved', async () => {
    await rejects(u.me.services.auth.updateMyProfile({ displayName: 'x'.repeat(101) }), ErrorCode.Validation, 'displayName');
    await rejects(u.me.services.auth.updateMyProfile({ bio: 'x'.repeat(1001) }), ErrorCode.Validation, 'bio');
    await rejects(u.me.services.auth.updateMyProfile({ avatarUrl: 'http://insecure.example/a.png' }), ErrorCode.Validation, 'avatarUrl');
    // @ts-expect-error status is not editable
    await rejects(u.me.services.auth.updateMyProfile({ status: 'active' }), ErrorCode.Validation, 'status');
    const saved = await u.me.services.auth.updateMyProfile({ displayName: '  Ada L.  ', firstName: 'Ada', lastName: 'Lovelace', bio: 'Engines.' });
    assert.deepEqual([saved.display_name, saved.first_name, saved.last_name, saved.bio], ['Ada L.', 'Ada', 'Lovelace', 'Engines.']);
    const cleared = await u.me.services.auth.updateMyProfile({ bio: null });
    assert.equal(cleared.bio, null);
  });

  test('nobody can edit someone else\'s profile', async () => {
    const { data } = await u.coMember.client.from('profiles').update({ display_name: 'Hijacked' }).eq('id', u.me.id).select();
    assert.deepEqual(data, []);
    assert.equal((await u.me.services.auth.getMyProfile()).display_name, 'Ada L.');
  });

  test('account information comes from Auth', async () => {
    const account = await u.me.services.auth.getMyAccount();
    assert.equal(account.userId, u.me.id);
    assert.equal(account.email, u.me.email);
    assert.equal(account.status, 'active');
    assert.ok(account.createdAt && account.emailConfirmedAt);
  });
});

describe('phone privacy', () => {
  test('the owner sets, reads and clears their phone number', async () => {
    await rejects(u.me.services.auth.setMyPhone('call me maybe'), ErrorCode.Validation, 'phone');
    await u.me.services.auth.setMyPhone('+44 20 7946 0000');
    assert.equal(await u.me.services.auth.getMyPhone(), '+44 20 7946 0000');
  });

  test('co-members, the community Owner and outsiders cannot read it', async () => {
    for (const viewer of [u.coMember, u.owner, u.outsider]) {
      const { data } = await viewer.client.from('profile_private').select('phone').eq('user_id', u.me.id);
      assert.deepEqual(data, [], `${viewer.email} must not see the phone number`);
      assert.equal(await viewer.services.auth.getMyPhone(), null, 'getMyPhone only ever returns your own');
    }
    const { error } = await u.coMember.client.from('profiles').select('phone').eq('id', u.me.id);
    assert.equal(error?.code, '42703', 'profiles have no phone column');
  });

  test('clearing works', async () => {
    await u.me.services.auth.setMyPhone(null);
    assert.equal(await u.me.services.auth.getMyPhone(), null);
    await u.me.services.auth.setMyPhone('+44 20 7946 0000');
  });
});

describe('avatar', () => {
  let first = '';

  test('upload: validated, stored in the private bucket, set on the profile', async () => {
    await rejects(u.me.services.auth.uploadMyAvatar({ file: jpeg(0), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'file');
    await rejects(u.me.services.auth.uploadMyAvatar({ file: jpeg(2 * 1024 * 1024 + 1), mimeType: 'image/jpeg' }), ErrorCode.Validation, 'file');
    // @ts-expect-error gif is not allowed
    await rejects(u.me.services.auth.uploadMyAvatar({ file: jpeg(), mimeType: 'image/gif' }), ErrorCode.Validation, 'mimeType');
    const profile = await u.me.services.auth.uploadMyAvatar({ file: jpeg(), mimeType: 'image/jpeg' });
    assert.match(profile.avatar_path ?? '', new RegExp(`^${u.me.id}/[0-9a-f-]{36}\\.jpg$`));
    first = profile.avatar_path!;
  });

  test('visible to the owner and co-members through signed URLs; not to outsiders or the public', async () => {
    const profile = await u.me.services.auth.getMyProfile();
    const mine = await u.me.services.auth.avatarUrl(profile);
    assert.ok(mine);
    assert.equal((await fetch(mine)).status, 200);
    const theirs = await u.coMember.services.auth.avatarUrl(profile);
    assert.ok(theirs, 'a co-member may see it');
    assert.equal(await u.outsider.services.auth.avatarUrl(profile), null, 'an outsider gets no URL');
    const publicUrl = admin.storage.from('avatars').getPublicUrl(profile.avatar_path!).data.publicUrl;
    assert.notEqual((await fetch(publicUrl)).status, 200, 'the bucket is not public');
  });

  test('replacing removes the old file; removing clears the profile and the file', async () => {
    const replaced = await u.me.services.auth.uploadMyAvatar({ file: jpeg(), mimeType: 'image/png' });
    assert.notEqual(replaced.avatar_path, first);
    const { data: files } = await admin.storage.from('avatars').list(u.me.id);
    assert.deepEqual(files?.map((f) => `${u.me.id}/${f.name}`), [replaced.avatar_path]);
    const removed = await u.me.services.auth.removeMyAvatar();
    assert.equal(removed.avatar_path, null);
    const { data: after } = await admin.storage.from('avatars').list(u.me.id);
    assert.deepEqual(after, []);
  });

  test('nobody can upload into another user\'s folder or adopt their file', async () => {
    const intrusion = await u.coMember.client.storage.from('avatars').upload(`${u.me.id}/00000000-0000-4000-8000-000000000000.jpg`, jpeg(), { contentType: 'image/jpeg' });
    assert.ok(intrusion.error, 'upload into another folder refused');
    const own = await u.coMember.services.auth.uploadMyAvatar({ file: jpeg(), mimeType: 'image/jpeg' });
    const { error } = await u.me.client.from('profiles').update({ avatar_path: own.avatar_path }).eq('id', u.me.id);
    assert.equal(error?.code, '42501');
    await u.coMember.services.auth.removeMyAvatar();
  });
});

describe('password and security', () => {
  test('changing the password re-checks the current one', async () => {
    await rejects(u.me.services.auth.changePassword({ currentPassword: 'Wrong-pass-9', newPassword: 'Brand-new-123' }), ErrorCode.Validation, 'currentPassword');
    await rejects(u.me.services.auth.changePassword({ currentPassword: 'CommuniOne-test-1', newPassword: 'short' }), ErrorCode.Validation, 'newPassword');
    await u.me.services.auth.changePassword({ currentPassword: 'CommuniOne-test-1', newPassword: 'Brand-new-123' });
    await assert.rejects(signIn(u.me.email), 'the old password no longer works');
    assert.ok((await signIn(u.me.email, 'Brand-new-123')).session);
  });
});

describe('account deletion', () => {
  test('the only Owner of a community with members is asked to transfer it first', async () => {
    const error = await rejects(u.owner.services.auth.deleteMyAccount(), ErrorCode.Conflict);
    assert.match(error.message, /transfer/i);
  });

  test('a member deletes their own account through the backend function; personal data goes', async () => {
    const avatar = await u.me.services.auth.uploadMyAvatar({ file: jpeg(), mimeType: 'image/jpeg' });
    await u.me.services.auth.deleteMyAccount();
    assert.equal((await u.me.client.auth.getSession()).data.session, null, 'signed out');
    const { data: profile } = await admin.from('profiles').select('id').eq('id', u.me.id);
    assert.deepEqual(profile, []);
    const { data: phone } = await admin.from('profile_private').select('user_id').eq('user_id', u.me.id);
    assert.deepEqual(phone, []);
    // The avatar file is personal data: no profile uses it any more, so the
    // purge job removes it once the grace period has passed (rules: pgTAP 024).
    const { data: users } = await admin.from('profiles').select('id').eq('avatar_path', avatar.avatar_path!);
    assert.deepEqual(users, []);
    const { error } = await admin.rpc('list_avatar_files_to_purge', { p_grace: '1 hour' });
    assert.equal(error, null, 'the purge listing is available to the service role');
  });
});

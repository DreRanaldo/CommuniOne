// Session behaviour end to end: unauthenticated access, invalid / expired /
// tampered tokens, logout and refresh. Authentication state is decided by
// the server (Supabase Auth + Postgres), never by what the client claims.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANON_KEY,
  SUPABASE_URL,
  anonClient,
  clientWithToken,
  createConfirmedUser,
  decodeJwt,
  deleteTrackedUsers,
  rest,
  signIn,
  signLegacyJwt,
} from './helpers.mjs';

after(deleteTrackedUsers);

describe('unauthenticated users cannot access protected resources', () => {
  for (const table of ['profiles', 'communities', 'memberships', 'roles', 'membership_roles', 'role_permissions', 'permissions', 'platform_admins']) {
    test(`anon cannot read ${table}`, async () => {
      const { data, error } = await anonClient().from(table).select('*').limit(1);
      assert.equal(data, null);
      assert.equal(error?.code, '42501');
    });
  }

  test('anon cannot create a community', async () => {
    const { error } = await anonClient().rpc('create_community', { p_name: 'Anon', p_slug: 'anon-community' });
    assert.equal(error?.code, '42501');
  });

  test('anon cannot call the permission check or the admin path', async () => {
    const { error: permissionError } = await anonClient().rpc('has_community_permission', {
      p_community_id: crypto.randomUUID(),
      p_permission_key: 'community.view',
    });
    assert.equal(permissionError?.code, '42501');

    const { error: adminError } = await anonClient().rpc('admin_set_account_status', {
      p_user_id: crypto.randomUUID(),
      p_status: 'suspended',
    });
    assert.equal(adminError?.code, '42501');
  });

  test('requests without an API key are rejected by the gateway', async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`);
    assert.equal(response.status, 401);
  });
});

describe('invalid and expired tokens are rejected server-side', () => {
  test('an expired token is rejected even though its signature is valid', async () => {
    const user = await createConfirmedUser('expired');
    const { session } = await signIn(user.email);
    const claims = decodeJwt(session.access_token);
    const now = Math.floor(Date.now() / 1000);
    const expired = signLegacyJwt({ ...claims, iat: now - 7200, exp: now - 3600 });

    const { status, body } = await rest('profiles?select=id', { token: expired });
    assert.equal(status, 401);
    assert.equal(body.code, 'PGRST303', 'JWT expired');
  });

  test('a tampered token (claims changed after signing) is rejected', async () => {
    const victim = await createConfirmedUser('tamper-victim');
    const attacker = await createConfirmedUser('tamper-attacker');
    const { session } = await signIn(attacker.email);
    const [header, payload, signature] = session.access_token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: victim.id }),
    ).toString('base64url');

    const { status } = await rest('profiles?select=id', { token: `${header}.${forgedPayload}.${signature}` });
    assert.equal(status, 401);
  });

  test('a garbage token is rejected', async () => {
    const { status } = await rest('profiles?select=id', { token: 'not.a.jwt' });
    assert.equal(status, 401);
  });

  test('a validly signed token for a session that does not exist grants nothing', async () => {
    const user = await createConfirmedUser('no-session');
    const { session } = await signIn(user.email);
    const claims = decodeJwt(session.access_token);
    const forged = signLegacyJwt({ ...claims, session_id: crypto.randomUUID() });

    const { status, body } = await rest('profiles?select=id', { token: forged });
    assert.equal(status, 200);
    assert.deepEqual(body, [], 'not even the user\'s own profile is visible');

    const created = await rest('rpc/create_community', {
      token: forged,
      method: 'POST',
      body: { p_name: 'Forged', p_slug: `forged-${user.id.slice(0, 8)}` },
    });
    assert.equal(created.body.code, '42501');
  });

  test('the client-side session object is not trusted: getUser() asks the server', async () => {
    const user = await createConfirmedUser('getuser');
    const { client, session } = await signIn(user.email);
    const { data, error } = await client.auth.getUser(session.access_token);
    assert.equal(error, null);
    assert.equal(data.user.id, user.id);

    const { error: forgedError } = await client.auth.getUser(signLegacyJwt({ sub: user.id, role: 'authenticated', exp: 1 }));
    assert.ok(forgedError, 'Supabase Auth rejects an expired token');
  });
});

describe('logout', () => {
  test('after sign-out the old access token stops working immediately', async () => {
    const user = await createConfirmedUser('logout');
    const { client, session } = await signIn(user.email);
    const stale = clientWithToken(session.access_token);

    const { data: before } = await stale.from('profiles').select('id').eq('id', user.id);
    assert.equal(before.length, 1, 'token works before sign-out');

    const { error } = await client.auth.signOut();
    assert.equal(error, null);

    // The JWT has not expired and its signature is valid, but its session
    // no longer exists, so the database treats the caller as nobody.
    assert.ok(decodeJwt(session.access_token).exp > Date.now() / 1000, 'token is not expired');
    const { data: after } = await stale.from('profiles').select('id').eq('id', user.id);
    assert.deepEqual(after, []);

    const { error: rpcError } = await stale.rpc('create_community', { p_name: 'Ghost', p_slug: `ghost-${user.id.slice(0, 8)}` });
    assert.equal(rpcError?.code, '42501');

    const { error: getUserError } = await anonClient().auth.getUser(session.access_token);
    assert.ok(getUserError, 'Supabase Auth also rejects the signed-out token');
  });

  test('after sign-out the refresh token cannot be used to get a new session', async () => {
    const user = await createConfirmedUser('refresh-after-logout');
    const { client, session } = await signIn(user.email);
    await client.auth.signOut();

    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: session.refresh_token });
    assert.equal(data.session, null);
    assert.ok(error);
  });

  test('signing out "others" revokes other devices but keeps the current one', async () => {
    const user = await createConfirmedUser('multi-device');
    const phone = await signIn(user.email);
    const laptop = await signIn(user.email);

    const { error } = await phone.client.auth.signOut({ scope: 'others' });
    assert.equal(error, null);

    const { data: phoneView } = await clientWithToken(phone.session.access_token).from('profiles').select('id').eq('id', user.id);
    const { data: laptopView } = await clientWithToken(laptop.session.access_token).from('profiles').select('id').eq('id', user.id);
    assert.equal(phoneView.length, 1, 'current device still signed in');
    assert.deepEqual(laptopView, [], 'other device signed out');
  });
});

describe('session refresh', () => {
  test('refreshing issues a new working access token for the same session', async () => {
    const user = await createConfirmedUser('refresh');
    const { client, session } = await signIn(user.email);

    const { data, error } = await client.auth.refreshSession();
    assert.equal(error, null);
    assert.notEqual(data.session.access_token, session.access_token);
    assert.notEqual(data.session.refresh_token, session.refresh_token, 'refresh tokens rotate');
    assert.equal(decodeJwt(data.session.access_token).session_id, decodeJwt(session.access_token).session_id);

    const { data: rows } = await clientWithToken(data.session.access_token).from('profiles').select('id').eq('id', user.id);
    assert.equal(rows.length, 1);
  });
});

test('sanity: ANON_KEY is the anon role, not a user', () => {
  assert.equal(decodeJwt(ANON_KEY).role, 'anon');
});

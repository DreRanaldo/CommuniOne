// Unit tests for the auth service's link handling, sign-up privacy, network
// detection and the onError hook, with a scripted fake Supabase client.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, ErrorCode, ServiceError, type Database } from '../../services/index.ts';
import { fromDbError, toServiceError } from '../../services/core/errors.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

type Call = { method: string; args: unknown[] };

function fakeClient(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Call[] = [];
  const record = (method: string, result: unknown) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve(overrides[method] ? overrides[method](...args) : result);
  };
  const auth = {
    getSession: record('getSession', { data: { session: { user: { id: 'u1' } } }, error: null }),
    exchangeCodeForSession: record('exchangeCodeForSession', { data: { session: {} }, error: null }),
    signUp: record('signUp', { data: { user: { id: 'u1' }, session: null }, error: null }),
    updateUser: record('updateUser', { data: { user: {} }, error: null }),
  };
  return { client: { auth } as unknown as SupabaseClient<Database>, calls };
}

const rejectsWith = async (promise: Promise<unknown>, code: string, pattern?: RegExp) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

describe('auth links (handleAuthRedirect)', () => {
  test('a confirmation link exchanges its code and signs in', async () => {
    const { client, calls } = fakeClient();
    const result = await createServices(client).auth.handleAuthRedirect('communione://auth/callback?code=abc123');
    assert.deepEqual(result, { kind: 'signedIn' });
    assert.deepEqual(calls.find((c) => c.method === 'exchangeCodeForSession')?.args, ['abc123']);
  });

  test('a recovery link is reported as recovery (https links too)', async () => {
    const { client } = fakeClient();
    const services = createServices(client);
    assert.deepEqual(await services.auth.handleAuthRedirect('communione://auth/reset-password?code=x'), { kind: 'recovery' });
    assert.deepEqual(await services.auth.handleAuthRedirect('https://app.example/auth/reset-password/?code=x'), { kind: 'recovery' });
  });

  test('error links, unknown routes, missing codes and junk are refused without an exchange', async () => {
    const { client, calls } = fakeClient();
    const auth = createServices(client).auth;
    for (const link of [
      'communione://auth/callback?error=access_denied&error_code=otp_expired',
      'communione://auth/callback#error=access_denied&error_code=otp_expired&error_description=x',
      'communione://auth/elsewhere?code=abc',
      'communione://join?code=abc',
      'communione://auth/callback',
      `communione://auth/callback?code=${'x'.repeat(600)}`,
      'not a url',
    ]) {
      await rejectsWith(auth.handleAuthRedirect(link), ErrorCode.Validation, /invalid or has expired/);
    }
    assert.equal(calls.filter((c) => c.method === 'exchangeCodeForSession').length, 0);
  });

  test('a link from another device explains where to open it', async () => {
    const { client } = fakeClient({
      exchangeCodeForSession: () => ({ data: { session: null }, error: { name: 'AuthPKCECodeVerifierMissingError', code: 'pkce_code_verifier_not_found', status: 400, message: 'x' } }),
    });
    await rejectsWith(createServices(client).auth.handleAuthRedirect('communione://auth/callback?code=abc'), ErrorCode.Validation, /device where you requested it/);
  });

  test('a network failure during the exchange is retryable, not "expired"', async () => {
    const { client } = fakeClient({
      exchangeCodeForSession: () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } }),
    });
    await assert.rejects(createServices(client).auth.handleAuthRedirect('communione://auth/callback?code=abc'), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.details.network, true);
      return true;
    });
  });
});

describe('sign-up privacy', () => {
  test('an already-registered address answers like a new sign-up', async () => {
    const { client } = fakeClient({
      signUp: () => ({ data: { user: null, session: null }, error: { name: 'AuthApiError', code: 'user_already_exists', status: 422, message: 'User already registered' } }),
    });
    assert.deepEqual(await createServices(client).auth.signUp({ email: 'ada@example.test', password: 'Correct-horse-1' }), {
      userId: null,
      needsEmailConfirmation: true,
    });
  });

  test('passwords are checked before anything is sent', async () => {
    const { client, calls } = fakeClient();
    const auth = createServices(client).auth;
    await rejectsWith(auth.signUp({ email: 'ada@example.test', password: 'short1' }), ErrorCode.Validation);
    await rejectsWith(auth.updatePassword('nodigitshere'), ErrorCode.Validation);
    assert.equal(calls.filter((c) => c.method === 'signUp' || c.method === 'updateUser').length, 0);
  });

  test('reusing the current password gets a clear message', async () => {
    const { client } = fakeClient({ updateUser: () => ({ data: { user: null }, error: { name: 'AuthApiError', code: 'same_password', status: 422, message: 'x' } }) });
    await rejectsWith(createServices(client).auth.updatePassword('Correct-horse-1'), ErrorCode.Validation, /not used here before/);
  });
});

describe('network errors', () => {
  test('transport failures are flagged as network errors', () => {
    for (const error of [
      { message: 'TypeError: Network request failed', code: '', status: 0 },
      { message: 'FetchError: request to http://x failed, reason: connect ECONNREFUSED', code: '' },
      { message: 'Failed to fetch' },
    ]) {
      const translated = fromDbError(error);
      assert.equal(translated.code, ErrorCode.ServerError);
      assert.equal(translated.details.network, true);
    }
    assert.equal(toServiceError(new TypeError('Network request failed')).details.network, true);
  });

  test('database errors are not mistaken for network errors', () => {
    assert.equal(fromDbError({ code: '42501', message: 'permission denied', status: 403 }).details.network, undefined);
    assert.equal(fromDbError({ code: 'XX000', message: 'boom' }).details.network, undefined);
  });
});

describe('onError hook', () => {
  test('receives every translated failure with its operation; a throwing listener is ignored', async () => {
    const seen: string[] = [];
    const { client } = fakeClient({ getSession: () => ({ data: { session: null }, error: null }) });
    const services = createServices(client, {
      onError: (error, operation) => {
        seen.push(`${operation}:${error.code}`);
        throw new Error('listener bug');
      },
    });
    await rejectsWith(services.auth.updatePassword('Correct-horse-1'), ErrorCode.Unauthenticated);
    assert.deepEqual(seen, ['auth.updatePassword:UNAUTHENTICATED']);
  });
});

describe('an outdated server', () => {
  test('a missing function or table says a migration is missing, without internals', () => {
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function public.create_post(p_body, p_community_id) in the schema cache' },
      { code: '42883', message: 'function public.create_story(uuid) does not exist' },
      { code: 'PGRST205', message: "Could not find the table 'public.stories' in the schema cache" },
    ]) {
      const translated = fromDbError(error);
      assert.equal(translated.code, ErrorCode.ServerError);
      assert.match(translated.message, /database migration has not been applied/);
      assert.doesNotMatch(translated.message, /create_post|create_story|stories|schema/);
    }
  });
});

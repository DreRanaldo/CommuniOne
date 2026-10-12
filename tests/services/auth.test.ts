// Service layer: authentication flows against the real local Supabase Auth,
// with the same client settings as the mobile app (PKCE, persisted session).
//
// Email links are read from Mailpit and "opened" by following their redirect,
// exactly as the phone does when it receives communione://auth/... .
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServices, ErrorCode, ServiceError, type Database, type Services } from '../../services/index.ts';
import { admin, ANON_KEY, MAILPIT_URL, SUPABASE_URL, trackUser, uniqueEmail } from '../integration/helpers.mjs';
import { deleteTrackedUsers, rejects } from './setup.ts';

after(deleteTrackedUsers);

const CALLBACK = 'communione://auth/callback';
const RESET = 'communione://auth/reset-password';
const PASSWORD = 'First-pass-123';
const NEW_PASSWORD = 'Second-pass-456';

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

/** A "device": its own client (PKCE verifier and session live in its storage) and services. */
function device(url = SUPABASE_URL) {
  const client = createClient<Database>(url, ANON_KEY, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: memoryStorage() },
  });
  const errors: { code: string; operation: string }[] = [];
  const services = createServices(client, { onError: (error, operation) => errors.push({ code: error.code, operation }) });
  return { client: client as SupabaseClient<Database>, services, errors };
}

async function emailCount(address: string): Promise<number> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  return ((await response.json()) as { messages_count?: number; messages?: unknown[] }).messages?.length ?? 0;
}

/** Waits for a new email to `address` and returns the app URL its link redirects to. */
async function openNextEmailLink(address: string, before: number): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json() as { messages: { ID: string }[] };
    if (search.messages.length > before) {
      const message = await (await fetch(`${MAILPIT_URL}/api/v1/message/${search.messages[0]!.ID}`)).json() as { HTML: string };
      const link = /href="([^"]+)"/.exec(message.HTML)?.[1]?.replace(/&amp;/g, '&');
      assert.ok(link, 'the email contains a link');
      const response = await fetch(link, { redirect: 'manual' });
      const location = response.headers.get('location');
      assert.ok(location, 'the link redirects to the app');
      return location;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${address}`);
}

async function userIdFor(address: string): Promise<string> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const found = data.users.find((u) => u.email === address);
  assert.ok(found);
  return found.id;
}

describe('sign up with email confirmation', () => {
  const email = uniqueEmail('signup');
  const phone = device();
  let confirmLink = '';

  let emailsBefore = 0;

  test('sign up: no session until the email is confirmed', async () => {
    emailsBefore = await emailCount(email);
    const result = await phone.services.auth.signUp({ email, password: PASSWORD, displayName: 'Ada', emailRedirectTo: CALLBACK });
    assert.deepEqual(result, { userId: result.userId, needsEmailConfirmation: true });
    trackUser(await userIdFor(email));
  });

  test('sign in before confirming: the same message as a wrong password', async () => {
    const error = await rejects(device().services.auth.signIn({ email, password: PASSWORD }), ErrorCode.Unauthenticated);
    const wrong = await rejects(device().services.auth.signIn({ email, password: 'Wrong-pass-1' }), ErrorCode.Unauthenticated);
    assert.equal(error.message, wrong.message);
  });

  test('the confirmation email links back into the app', async () => {
    // Following the link confirms the address on the server; the app then
    // exchanges the code it receives for a session.
    confirmLink = await openNextEmailLink(email, emailsBefore);
    assert.match(confirmLink, /^communione:\/\/auth\/callback\?code=/);
  });

  test('signing up again with a registered email looks exactly like a new sign-up', async () => {
    const result = await device().services.auth.signUp({ email, password: 'Other-pass-789', emailRedirectTo: CALLBACK });
    assert.deepEqual(result, { userId: null, needsEmailConfirmation: true });
  });

  test('a link opened on another device asks for the original device', async () => {
    const error = await rejects(device().services.auth.handleAuthRedirect(confirmLink), ErrorCode.Validation, 'link');
    assert.match(error.message, /device where you requested it/);
  });

  test('opening the confirmation link signs the user in', async () => {
    assert.deepEqual(await phone.services.auth.handleAuthRedirect(confirmLink), { kind: 'signedIn' });
    const profile = await phone.services.auth.getMyProfile();
    assert.equal(profile.display_name, 'Ada');
  });

  test('a used link is reported as expired', async () => {
    const error = await rejects(phone.services.auth.handleAuthRedirect(`${CALLBACK}?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`), ErrorCode.Validation, 'link');
    assert.match(error.message, /invalid or has expired/);
    await rejects(phone.services.auth.handleAuthRedirect('communione://somewhere/else?code=abc'), ErrorCode.Validation, 'link');
    await rejects(phone.services.auth.handleAuthRedirect('not a url'), ErrorCode.Validation, 'link');
  });

  test('sign out ends the session', async () => {
    await phone.services.auth.signOut('local');
    assert.equal((await phone.client.auth.getSession()).data.session, null);
    await rejects(phone.services.auth.getMyProfile(), ErrorCode.Unauthenticated);
  });

  test('sign in after confirming', async () => {
    const session = await phone.services.auth.signIn({ email, password: PASSWORD });
    assert.ok(session.access_token);
  });
});

describe('password reset', () => {
  const email = uniqueEmail('reset');
  const phone = device();

  test('setup: a confirmed account', async () => {
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    assert.equal(error, null);
    trackUser(data.user!.id);
  });

  test('requesting a reset looks identical for known and unknown addresses', async () => {
    const unknown = uniqueEmail('nobody');
    await phone.services.auth.requestPasswordReset({ email: unknown, redirectTo: RESET });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await emailCount(unknown), 0, 'no email is sent to an unknown address');
  });

  test('the reset link opens a recovery session; a new password replaces the old one', async () => {
    const before = await emailCount(email);
    await phone.services.auth.requestPasswordReset({ email, redirectTo: RESET });
    const link = await openNextEmailLink(email, before);
    assert.match(link, /^communione:\/\/auth\/reset-password\?code=/);
    assert.deepEqual(await phone.services.auth.handleAuthRedirect(link), { kind: 'recovery' });

    await rejects(phone.services.auth.updatePassword('short'), ErrorCode.Validation, 'password');
    await rejects(phone.services.auth.updatePassword('lettersonly'), ErrorCode.Validation, 'password');
    await phone.services.auth.updatePassword(NEW_PASSWORD);

    await rejects(device().services.auth.signIn({ email, password: PASSWORD }), ErrorCode.Unauthenticated);
    assert.ok((await device().services.auth.signIn({ email, password: NEW_PASSWORD })).access_token);
  });

  test('updating the password needs a session', async () => {
    await rejects(device().services.auth.updatePassword(NEW_PASSWORD), ErrorCode.Unauthenticated);
  });
});

describe('expired and revoked sessions', () => {
  const email = uniqueEmail('expiry');

  test('a session revoked elsewhere: data calls fail UNAUTHENTICATED and the listener hears it', async () => {
    const { data } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    trackUser(data.user!.id);
    const phone = device();
    await phone.services.auth.signIn({ email, password: PASSWORD });
    const laptop = device();
    await laptop.services.auth.signIn({ email, password: PASSWORD });
    await laptop.services.auth.signOut('global');

    await rejects(phone.services.communities.create({ name: 'Ghost', slug: `ghost-${Date.now()}` }), ErrorCode.Unauthenticated);
    assert.deepEqual(phone.errors.at(-1), { code: ErrorCode.Unauthenticated, operation: 'communities.create' });
  });

  test('checking the session with Auth clears a revoked session and emits SIGNED_OUT', async () => {
    const phone = device();
    const events: string[] = [];
    phone.client.auth.onAuthStateChange((event) => events.push(event));
    await phone.services.auth.signIn({ email, password: PASSWORD });
    await device().services.auth.signIn({ email, password: PASSWORD }).then(async () => {
      const other = device();
      await other.services.auth.signIn({ email, password: PASSWORD });
      await other.services.auth.signOut('global');
    });
    const { error } = await phone.client.auth.getUser();
    assert.ok(error);
    assert.equal((await phone.client.auth.getSession()).data.session, null);
    assert.ok(events.includes('SIGNED_OUT'));
  });
});

describe('network failures', () => {
  test('an unreachable server is a retryable network error, not a credentials error', async () => {
    const offline = device('http://127.0.0.1:9');
    const error = await rejects(offline.services.auth.signIn({ email: 'a@example.test', password: PASSWORD }), ErrorCode.ServerError);
    assert.equal(error.details.network, true);
    assert.match(error.message, /couldn't reach/);
    const reset = await rejects(offline.services.auth.requestPasswordReset({ email: 'a@example.test' }), ErrorCode.ServerError);
    assert.equal(reset.details.network, true, 'a reset request that never left the phone is not reported as sent');
    assert.ok(error instanceof ServiceError);
  });
});

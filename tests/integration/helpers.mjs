// Shared helpers for the end-to-end auth tests.
//
// These tests talk to the LOCAL Supabase stack exactly like a client app
// would: Supabase Auth over HTTP for sign-up / sign-in / sign-out, and the
// Data API (PostgREST) for data. They create real users, so they refuse to
// run against anything but localhost.
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run the tests via: npm run test:integration`);
  return value;
};

export const SUPABASE_URL = env('SUPABASE_URL');
export const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const JWT_SECRET = env('SUPABASE_JWT_SECRET');
export const MAILPIT_URL = env('MAILPIT_URL');

const { hostname } = new URL(SUPABASE_URL);
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
  throw new Error(`Refusing to run integration tests against non-local Supabase: ${SUPABASE_URL}`);
}

export const PASSWORD = 'CommuniOne-test-1';

const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Trusted server-side client (service role). Test setup/inspection only. */
export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: noPersist });

/** A fresh client with no session, as a signed-out app would have. */
export const anonClient = () => createClient(SUPABASE_URL, ANON_KEY, { auth: noPersist });

/** A client that sends a fixed access token (no refresh), like a stale app. */
export const clientWithToken = (accessToken) =>
  createClient(SUPABASE_URL, ANON_KEY, {
    auth: noPersist,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

export const uniqueEmail = (label) => `${label}-${randomUUID().slice(0, 8)}@example.test`;

const createdUserIds = new Set();
export const trackUser = (id) => createdUserIds.add(id);

/** Creates an email-confirmed user through the Auth admin API. */
export async function createConfirmedUser(label, metadata = {}) {
  const email = uniqueEmail(label);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (error) throw error;
  trackUser(data.user.id);
  return { id: data.user.id, email };
}

/** Signs in with email + password and returns { client, session }. */
export async function signIn(email, password = PASSWORD) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { client, session: data.session };
}

const createdCommunityIds = new Set();
export const trackCommunity = (id) => createdCommunityIds.add(id);

/** Looks up a role id by name (test setup only; never authorize on names). */
export async function roleId(communityId, name) {
  const { data, error } = await admin.from('roles').select('id').eq('community_id', communityId).eq('name', name).single();
  if (error) throw error;
  return data.id;
}

/**
 * Adds a membership as trusted backend code would. Clients cannot insert
 * memberships; invitation / join flows will do this in a later stage.
 */
export async function addMember(communityId, userId, roleName, status = 'active') {
  const { data, error } = await admin
    .from('memberships')
    .insert({ community_id: communityId, user_id: userId, status })
    .select('id')
    .single();
  if (error) throw error;
  if (roleName) {
    await admin
      .from('membership_roles')
      .insert({ membership_id: data.id, role_id: await roleId(communityId, roleName) })
      .throwOnError();
  }
  return data.id;
}

/** Hard-deletes tracked communities (communities RESTRICT, so children first). */
export async function deleteTrackedCommunities() {
  for (const id of createdCommunityIds) {
    await admin.from('membership_roles').delete().eq('community_id', id);
    await admin.from('memberships').delete().eq('community_id', id);
    await admin.from('roles').delete().eq('community_id', id);
    await admin.from('communities').delete().eq('id', id);
  }
  createdCommunityIds.clear();
}

export async function deleteTrackedUsers() {
  await deleteTrackedCommunities();
  for (const id of createdUserIds) {
    await admin.from('platform_admins').delete().eq('user_id', id);
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.clear();
}

/** Raw Data API request with an arbitrary bearer token. */
export async function rest(path, { token, method = 'GET', body } = {}) {
  const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs an HS256 JWT with the local project's legacy JWT secret. */
export function signLegacyJwt(payload) {
  const unsigned = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const signature = createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export const decodeJwt = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

/** Finds the newest Mailpit message sent to `email` and returns its HTML. */
export async function latestEmailHtml(email) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = await search.json();
    if (messages.length > 0) {
      const message = await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`);
      return (await message.json()).HTML;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No email received for ${email}`);
}

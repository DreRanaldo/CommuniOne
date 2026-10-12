// Shared setup for the service-layer integration tests: real users, signed
// in with the anon key exactly like the mobile app, each with their own
// services instance. Uses the local stack only (helpers.mjs refuses others).
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, signIn, trackCommunity } from '../integration/helpers.mjs';
import { createServices, ServiceError, type Database, type LogLevel, type Services } from '../../services/index.ts';

export { admin, addMember, deleteTrackedUsers, trackCommunity };

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient<Database>;
  services: Services;
  /** Everything the services logged for this user (already redacted). */
  logs: { level: LogLevel; event: string; fields?: Record<string, unknown> }[];
}

export async function user(label: string): Promise<TestUser> {
  const created = await createConfirmedUser(label);
  const { client } = await signIn(created.email);
  const logs: TestUser['logs'] = [];
  const services = createServices(client as SupabaseClient<Database>, {
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
  });
  return { ...created, client: client as SupabaseClient<Database>, services, logs };
}

export async function users<K extends string>(...labels: K[]): Promise<Record<K, TestUser>> {
  const out = {} as Record<K, TestUser>;
  for (const label of labels) out[label] = await user(label.toLowerCase());
  return out;
}

/** Creates a community through the service as `owner` and tracks it for cleanup. */
export async function community(owner: TestUser, label: string): Promise<string> {
  const created = await owner.services.communities.create({
    name: `Svc ${label}`, slug: `svc-${label.toLowerCase()}-${owner.id.slice(0, 8)}`, type: 'residential',
  });
  trackCommunity(created.id);
  return created.id;
}

/** Asserts a ServiceError with the given code (and optional field). */
export async function rejects(promise: Promise<unknown>, code: string, field?: string): Promise<ServiceError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServiceError, `expected ServiceError ${code}, got ${caught === undefined ? 'success' : String(caught)}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  if (field) assert.equal(caught.details.field, field);
  // Client-facing errors never carry database internals.
  assert.doesNotMatch(JSON.stringify(caught), /relation|constraint|policy|permission denied for|PGRST|SQL/i);
  return caught;
}

/** Removes rows that block community deletion in cleanup. */
export async function cleanupCommunityContent(communityIds: string[]): Promise<void> {
  for (const id of communityIds) {
    for (const table of ['invitation_redemptions', 'invitations', 'alerts', 'events', 'documents', 'document_folders', 'announcements', 'posts'] as const) {
      await admin.from(table).delete().eq('community_id', id);
    }
  }
  await deleteTrackedUsers();
}

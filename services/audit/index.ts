// Audit log (read-only). Requires audit.view in the community; system
// events (communityId omitted) are for platform admins. Entries are written
// only by the database.

import { unwrap, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Tables } from '../database.types.ts';

export type AuditEntry = Tables<'audit_logs'>;

export interface AuditQuery extends PageRequest {
  /** Omit for platform-level system events (platform admins only). */
  communityId?: string;
  action?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
}

export function auditService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Newest first. */
    list(input: AuditQuery = {}): Promise<Page<AuditEntry>> {
      return ctx.run('audit.list', async () => {
        await ctx.requireUserId();
        v.only<AuditQuery>(input, 'input', ['communityId', 'action', 'actorUserId', 'entityType', 'entityId', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_audit_logs', {
          // The RPC takes NULL for system events.
          p_community_id: (v.optionalUuid(input.communityId, 'communityId') ?? null) as string,
          p_limit: limit,
          p_cursor_created_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
          p_action: input.action === undefined ? undefined : v.text(input.action, 'action', { max: 64, pattern: /^[a-z_]+\.[a-z_]+$/ }),
          p_actor_user_id: v.optionalUuid(input.actorUserId, 'actorUserId') ?? undefined,
          p_entity_type: input.entityType === undefined ? undefined : v.text(input.entityType, 'entityType', { max: 64, pattern: /^[a-z_]+$/ }),
          p_entity_id: v.optionalUuid(input.entityId, 'entityId') ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },
  };
}

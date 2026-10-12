// Roles: list a community's roles and assign or unassign them. Needed, for
// example, to hand over the Owner role before leaving or deleting an account.
// Requires roles.manage, never on your own membership, and only for roles
// whose permissions the caller already holds (database anti-escalation rule).
// Permission sets of roles are managed by the database's role templates and
// are not exposed as a generic "update permissions" operation.

import { mutateOne, unwrap, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';
import type { TablesInsert } from '../database.types.ts';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  isDefaultForNewMembers: boolean;
}

export function rolesService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Roles of a community. Requires roles.view. */
    list(communityId: string): Promise<Role[]> {
      return ctx.run('roles.list', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.from('roles')
          .select('id, name, description, is_system_role, is_default_for_new_members')
          .eq('community_id', v.uuid(communityId, 'communityId'))
          .order('name')
          .limit(200)) ?? [];
        return rows.map((r) => ({
          id: r.id, name: r.name, description: r.description,
          isSystemRole: r.is_system_role, isDefaultForNewMembers: r.is_default_for_new_members,
        }));
      });
    },

    /** Gives a member a role (same community enforced by composite foreign keys). */
    assign(membershipId: string, roleId: string): Promise<void> {
      return ctx.run('roles.assign', async () => {
        await ctx.requireUserId();
        unwrap(await db.from('membership_roles').insert({
          membership_id: v.uuid(membershipId, 'membershipId'),
          role_id: v.uuid(roleId, 'roleId'),
        } as TablesInsert<'membership_roles'>)); // community_id is derived from the membership by trigger
      });
    },

    unassign(membershipId: string, roleId: string): Promise<void> {
      return ctx.run('roles.unassign', async () => {
        await ctx.requireUserId();
        const m = v.uuid(membershipId, 'membershipId');
        const r = v.uuid(roleId, 'roleId');
        await mutateOne(
          () => db.from('membership_roles').delete().eq('membership_id', m).eq('role_id', r).select('id'),
          () => db.from('membership_roles').select('id').eq('membership_id', m).eq('role_id', r),
          'Role assignment not found.',
        );
      });
    },
  };
}

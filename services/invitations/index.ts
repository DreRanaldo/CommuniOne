// Invitations (inviteMember): create a shareable token, list, revoke, and
// redeem. Every operation is one SECURITY DEFINER RPC; redemption is atomic
// and row-locked in the database (membership + default role + usage count).

import { firstRow, unwrap, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';

export interface CreatedInvitation {
  invitationId: string;
  /** Shown exactly once; only its hash is stored. Share it, never log it. */
  token: string;
  expiresAt: string;
  maxUses: number | null;
}

export interface InvitationSummary {
  id: string;
  communityId: string;
  createdBy: string | null;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
}

/** What an invitation would join (preview_invitation): shown before accepting. */
export interface InvitationPreview {
  communityId: string;
  name: string;
  type: string;
  description: string | null;
  logo_path: string | null;
  logo_url: string | null;
  cover_image_path: string | null;
  cover_image_url: string | null;
  memberCount: number;
  expiresAt: string;
  /** The caller's existing membership, if any: 'active' (already a member), 'suspended' (cannot join), 'pending' / 'left' / 'rejected' (joining re-admits). */
  membershipStatus: string | null;
}

const TOKEN = /^ci_[0-9a-f]{64}$/;

/** Accepts a raw token or a link containing ?token=... */
export function parseInvitationToken(input: unknown): string {
  const raw = v.text(input, 'token', { max: 2048 });
  let candidate = raw;
  const encoded = /[?&]token=([^&#\s]+)/.exec(raw)?.[1];
  if (encoded !== undefined) {
    try { candidate = decodeURIComponent(encoded); } catch { candidate = encoded; }
  }
  return v.text(candidate, 'token', { max: 67, pattern: TOKEN, patternMessage: 'This is not a valid invitation code.' });
}

export function invitationsService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Requires members.invite. Expires in 1 hour – 30 days (default 7 days); maxUses 1–10 000 or unlimited. */
    create(input: { communityId: string; expiresIn?: string; maxUses?: number | null }): Promise<CreatedInvitation> {
      return ctx.run('invitations.create', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'expiresIn', 'maxUses']);
        const rows = unwrap(await db.rpc('create_invitation', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_expires_in: input.expiresIn === undefined ? undefined : v.interval(input.expiresIn, 'expiresIn'),
          p_max_uses: input.maxUses === undefined || input.maxUses === null ? undefined : v.int(input.maxUses, 'maxUses', 1, 10_000),
        }));
        const row = firstRow(rows);
        return { invitationId: row.invitation_id, token: row.token, expiresAt: row.expires_at, maxUses: row.max_uses };
      });
    },

    /** Requires members.invite. Never returns tokens or hashes; at most 200 rows. */
    list(input: { communityId: string; includeInactive?: boolean }): Promise<InvitationSummary[]> {
      return ctx.run('invitations.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'includeInactive']);
        const rows = unwrap(await db.rpc('list_invitations', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_include_inactive: input.includeInactive === undefined ? false : v.bool(input.includeInactive, 'includeInactive'),
        })) ?? [];
        return rows.map((r) => ({
          id: r.id, communityId: r.community_id, createdBy: r.created_by, expiresAt: r.expires_at,
          maxUses: r.max_uses, useCount: r.use_count, status: r.effective_status as InvitationSummary['status'], createdAt: r.created_at,
        }));
      });
    },

    /** Requires members.invite in the invitation's community; otherwise NOT_FOUND. Returns false if already revoked. */
    revoke(invitationId: string): Promise<boolean> {
      return ctx.run('invitations.revoke', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('revoke_invitation', { p_invitation_id: v.uuid(invitationId, 'invitationId') })) as boolean;
      });
    },

    /**
     * Validates an invitation and shows its community WITHOUT joining or
     * consuming a use. Same refusals as redeem: NOT_FOUND (invalid),
     * VALIDATION (revoked, expired, used up, no longer valid).
     */
    preview(tokenOrLink: string): Promise<InvitationPreview> {
      return ctx.run('invitations.preview', async () => {
        await ctx.requireUserId();
        const row = firstRow(unwrap(await db.rpc('preview_invitation', { p_token: parseInvitationToken(tokenOrLink) })), 'invalid invitation');
        return {
          communityId: row.community_id,
          name: row.name,
          type: row.community_type,
          description: row.description,
          logo_path: row.logo_path,
          logo_url: row.logo_url,
          cover_image_path: row.cover_image_path,
          cover_image_url: row.cover_image_url,
          memberCount: row.member_count,
          expiresAt: row.expires_at,
          membershipStatus: row.membership_status,
        };
      });
    },

    /** Joins the invitation's community as an active member with the default role. */
    redeem(tokenOrLink: string): Promise<{ communityId: string; membershipId: string; status: string }> {
      return ctx.run('invitations.redeem', async () => {
        await ctx.requireUserId();
        const row = firstRow(unwrap(await db.rpc('redeem_invitation', { p_token: parseInvitationToken(tokenOrLink) })));
        return { communityId: row.community_id, membershipId: row.membership_id, status: row.membership_status };
      });
    },
  };
}

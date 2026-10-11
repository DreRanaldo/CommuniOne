// Communities: create, read, update, and the caller's memberships and
// permissions. Creation is one atomic RPC (community + Owner membership +
// default roles); reads and updates are authorized by RLS and column grants.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import * as v from '../core/validate.ts';
import type { Json, Tables } from '../database.types.ts';

export type Community = Tables<'communities'>;

export const COMMUNITY_TYPES = ['residential', 'church', 'school', 'club', 'association', 'organization', 'other'] as const;
export type CommunityType = (typeof COMMUNITY_TYPES)[number];

export interface CreateCommunityInput {
  name: string;
  slug: string;
  type?: CommunityType;
  description?: string;
  timezone?: string;
}

export interface CommunityPatch {
  name?: string;
  description?: string | null;
  type?: CommunityType;
  timezone?: string;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  settings?: Record<string, Json>;
}

const name = (value: unknown) => v.text(value, 'name', { max: 120 });
const slug = (value: unknown) => v.text(value, 'slug', {
  min: 3, max: 63, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, patternMessage: 'slug may contain lowercase letters, digits and single dashes.',
});
// IANA zone names like "America/Chicago" or "UTC"; the database checks they exist.
const timezone = (value: unknown) => v.text(value, 'timezone', { max: 64, pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/ });

export function communitiesService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** Creates a community; the caller becomes its Owner. At most 10 per user per 24 hours. */
    create(input: CreateCommunityInput): Promise<Community> {
      return ctx.run('communities.create', async () => {
        await ctx.requireUserId();
        v.only<CreateCommunityInput>(input, 'input', ['name', 'slug', 'type', 'description', 'timezone']);
        return unwrap(await db.rpc('create_community', {
          p_name: name(input.name),
          p_slug: slug(typeof input.slug === 'string' ? input.slug.toLowerCase() : input.slug),
          p_community_type: input.type === undefined ? 'other' : v.oneOf(input.type, 'type', COMMUNITY_TYPES),
          p_description: v.optionalText(input.description, 'description', { max: 2000 }) ?? undefined,
          p_timezone: input.timezone === undefined ? 'UTC' : timezone(input.timezone),
        })) as Community;
      });
    },

    /** One community the caller may view (active membership). */
    get(communityId: string): Promise<Community> {
      return ctx.run('communities.get', async () => {
        await ctx.requireUserId();
        const id = v.uuid(communityId, 'communityId');
        return unwrapOne(await db.from('communities').select('*').eq('id', id).maybeSingle(), 'Community not found.');
      });
    },

    getBySlug(communitySlug: string): Promise<Community> {
      return ctx.run('communities.getBySlug', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('communities').select('*').eq('slug', slug(communitySlug)).maybeSingle(), 'Community not found.');
      });
    },

    /** Requires community.update. Status and slug are never client-editable. */
    update(communityId: string, patch: CommunityPatch): Promise<Community> {
      return ctx.run('communities.update', async () => {
        await ctx.requireUserId();
        const id = v.uuid(communityId, 'communityId');
        v.only<CommunityPatch>(patch, 'patch', ['name', 'description', 'type', 'timezone', 'logoUrl', 'coverImageUrl', 'settings']);
        const row = v.nonEmptyPatch({
          name: patch.name === undefined ? undefined : name(patch.name),
          description: v.optionalText(patch.description, 'description', { max: 2000 }),
          community_type: patch.type === undefined ? undefined : v.oneOf(patch.type, 'type', COMMUNITY_TYPES),
          timezone: patch.timezone === undefined ? undefined : timezone(patch.timezone),
          logo_url: v.optionalHttpsUrl(patch.logoUrl, 'logoUrl'),
          cover_image_url: v.optionalHttpsUrl(patch.coverImageUrl, 'coverImageUrl'),
          settings: patch.settings === undefined ? undefined : v.jsonObject(patch.settings, 'settings', 16_000) as Record<string, Json>,
        }, 'patch');
        return mutateOne(
          () => db.from('communities').update(row).eq('id', id).select('*'),
          () => db.from('communities').select('id').eq('id', id),
          'Community not found.',
        );
      });
    },

    /** The caller's pending, active and suspended memberships (community switcher). */
    listMine() {
      return ctx.run('communities.listMine', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('my_communities')) ?? [];
      });
    },

    /** The caller's effective permission keys in a community, for showing or hiding UI only. */
    myPermissions(communityId: string): Promise<string[]> {
      return ctx.run('communities.myPermissions', async () => {
        await ctx.requireUserId();
        return (unwrap(await db.rpc('my_community_permissions', { p_community_id: v.uuid(communityId, 'communityId') })) ?? []) as string[];
      });
    },
  };
}

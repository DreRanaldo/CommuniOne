// Communities: create, read, update, and the caller's memberships and
// permissions. Creation is one atomic RPC (community + Owner membership +
// default roles); reads and updates are authorized by RLS and column grants.

import { ErrorCode, ServiceError } from '../core/errors.ts';
import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import * as v from '../core/validate.ts';
import type { Database, Json, Tables } from '../database.types.ts';

export type Community = Tables<'communities'>;
/** One of the caller's memberships, as listed by my_communities() (community switcher). */
export type MyCommunity = Database['public']['Functions']['my_communities']['Returns'][number];

export const COMMUNITY_MEDIA_BUCKET = 'community-media';
export const COMMUNITY_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const COMMUNITY_COVER_MAX_BYTES = 5 * 1024 * 1024;
export type CommunityImageKind = 'logo' | 'cover';
const IMAGE_COLUMNS = { logo: 'logo_path', cover: 'cover_image_path' } as const;

/** Anything carrying a community's image fields (a community row, my_communities(), an invitation preview). */
export interface CommunityImages {
  logo_path?: string | null;
  logo_url?: string | null;
  cover_image_path?: string | null;
  cover_image_url?: string | null;
}

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

    /**
     * Uploads a logo (≤ 2 MiB) or cover image (≤ 5 MiB), JPEG / PNG / WebP,
     * into the community's folder of the public community-media bucket, makes
     * it current, and removes the previous file. Requires community.update
     * (storage policy and RLS); otherwise FORBIDDEN.
     */
    uploadImage(communityId: string, kind: CommunityImageKind, input: { file: UploadBody; mimeType: ImageMimeType }): Promise<Community> {
      return ctx.run('communities.uploadImage', async () => {
        await ctx.requireUserId();
        const id = v.uuid(communityId, 'communityId');
        const column = IMAGE_COLUMNS[v.oneOf(kind, 'kind', ['logo', 'cover'] as const)];
        v.only<typeof input>(input, 'input', ['file', 'mimeType']);
        const { mimeType, ext } = checkImage(input, kind === 'logo' ? COMMUNITY_LOGO_MAX_BYTES : COMMUNITY_COVER_MAX_BYTES);
        const current = unwrapOne(await db.from('communities').select('logo_path, cover_image_path').eq('id', id).maybeSingle(), 'Community not found.');
        const path = `${id}/${randomId()}.${ext}`;
        const stored = await db.storage.from(COMMUNITY_MEDIA_BUCKET).upload(path, uploadBody(input.file, mimeType), { contentType: mimeType, upsert: false });
        if (stored.error) {
          // The storage policy refuses callers without community.update.
          const refused = /row-level security|unauthorized|403/i.test(`${stored.error.message} ${(stored.error as { statusCode?: string }).statusCode ?? ''}`);
          throw refused
            ? new ServiceError(ErrorCode.Forbidden, 'You cannot change this community\'s images.', {}, stored.error)
            : new ServiceError(ErrorCode.ServerError, 'The image could not be uploaded. Try again.', {}, stored.error);
        }
        const patch = kind === 'logo' ? { logo_path: path } : { cover_image_path: path };
        const rows = unwrap(await db.from('communities').update(patch).eq('id', id).select('*'));
        const updated = rows?.[0];
        if (!updated) {
          await db.storage.from(COMMUNITY_MEDIA_BUCKET).remove([path]);
          throw new ServiceError(ErrorCode.Forbidden, 'You cannot change this community\'s images.');
        }
        // Best effort: an unused file is otherwise removed by the purge job.
        const previous = current[column];
        if (previous) await db.storage.from(COMMUNITY_MEDIA_BUCKET).remove([previous]);
        return updated;
      });
    },

    /** Removes the logo or cover image (row first, then the file). Requires community.update. */
    removeImage(communityId: string, kind: CommunityImageKind): Promise<Community> {
      return ctx.run('communities.removeImage', async () => {
        await ctx.requireUserId();
        const id = v.uuid(communityId, 'communityId');
        const column = IMAGE_COLUMNS[v.oneOf(kind, 'kind', ['logo', 'cover'] as const)];
        const current = unwrapOne(await db.from('communities').select('logo_path, cover_image_path').eq('id', id).maybeSingle(), 'Community not found.');
        const patch = kind === 'logo' ? { logo_path: null, logo_url: null } : { cover_image_path: null, cover_image_url: null };
        const updated = await mutateOne(
          () => db.from('communities').update(patch).eq('id', id).select('*'),
          () => db.from('communities').select('id').eq('id', id),
          'Community not found.',
        );
        const previous = current[column];
        if (previous) await db.storage.from(COMMUNITY_MEDIA_BUCKET).remove([previous]);
        return updated;
      });
    },

    /**
     * Displayable URL of a community's logo or cover: the public URL of the
     * uploaded file, else the external https URL, else null. No network request.
     */
    imageUrl(community: CommunityImages, kind: CommunityImageKind): string | null {
      const path = kind === 'logo' ? community.logo_path : community.cover_image_path;
      if (path) return db.storage.from(COMMUNITY_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
      const url = kind === 'logo' ? community.logo_url : community.cover_image_url;
      return url && /^https:\/\//i.test(url) ? url : null;
    },

    /** The caller's pending, active and suspended memberships (community switcher). */
    listMine(): Promise<MyCommunity[]> {
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

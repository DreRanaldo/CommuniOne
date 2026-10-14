// Marketplace catalog (Stage B, migration 32): categories, seller profiles,
// listings (products and services), pictures, stock and favorites, per
// community (decision D1). Who may do what is decided by the database (RLS,
// enforce_listing_write / enforce_seller_profile_write, set_listing_stock).
// Money is integer minor units (JMD cents) and is never computed here.
// No cart, checkout or payment yet (docs/commerce/stages.md).

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, serverOutdated, ServiceError } from '../core/errors.ts';
import { checkImage, randomId, uploadBody, type ImageMimeType, type UploadBody } from '../core/files.ts';
import { decodeCursor, pageSize, type Page, type PageRequest, encodeCursor } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export const LISTING_IMAGES_BUCKET = 'listing-images';
export const LISTING_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LISTING_MAX_IMAGES = 10;
export const LISTING_KINDS = ['product', 'service'] as const;
export const LISTING_CONDITIONS = ['new', 'like_new', 'good', 'fair'] as const;
export const LISTING_PRICING = ['fixed', 'hourly', 'quote'] as const;
export const LISTING_STATUSES = ['draft', 'active', 'paused', 'removed'] as const;
export const FULFILLMENT_METHODS = ['pickup', 'seller_delivery'] as const;
export const LISTING_SORTS = ['newest', 'price_asc', 'price_desc', 'relevance'] as const;
/** Largest price accepted, in minor units (JMD 10 billion). */
export const MAX_PRICE_MINOR = 1_000_000_000_000;

export type ListingKind = (typeof LISTING_KINDS)[number];
export type Listing = Tables<'listings'>;
export type SearchRow = Database['public']['Functions']['search_listings']['Returns'][number];

export interface Category {
  id: string;
  slug: string;
  name: string;
  kind: ListingKind;
  icon: string | null;
}

export interface SellerProfile {
  id: string;
  communityId: string;
  userId: string;
  displayName: string;
  bio: string | null;
  status: 'active' | 'paused' | 'suspended';
  verified: boolean;
}

/** A storefront card: what search returns, plus a signed cover picture. */
export interface ListingCard {
  id: string;
  kind: ListingKind;
  title: string;
  categoryName: string;
  condition: string | null;
  pricing: string;
  priceMinor: number | null;
  currency: string;
  /** Products: on hand minus reserved; services: null. */
  available: number | null;
  sellerProfileId: string;
  sellerName: string;
  sellerVerified: boolean;
  coverUrl: string | null;
  imageCount: number;
  isFavorite: boolean;
  publishedAt: string | null;
}

export interface ListingImage {
  id: string;
  path: string;
  url: string | null;
  position: number;
  width: number;
  height: number;
}

export interface ListingDetail {
  listing: Listing;
  category: Category | null;
  seller: SellerProfile | null;
  images: ListingImage[];
  /** Products only. */
  stock: { onHand: number; reserved: number; available: number } | null;
  isFavorite: boolean;
  isMine: boolean;
}

export interface ListingInput {
  communityId: string;
  kind: ListingKind;
  categoryId: string;
  title: string;
  description?: string;
  condition?: (typeof LISTING_CONDITIONS)[number] | null;
  pricing?: (typeof LISTING_PRICING)[number];
  priceMinor?: number | null;
  fulfillment?: (typeof FULFILLMENT_METHODS)[number][];
  pickupArea?: string | null;
  serviceArea?: string | null;
  /** Publish now (active) or keep as a draft (default). */
  publish?: boolean;
}

export type ListingPatch = Partial<Omit<ListingInput, 'communityId' | 'kind' | 'publish'>>;

export interface SearchInput extends PageRequest {
  communityId: string;
  query?: string;
  categoryId?: string;
  kind?: ListingKind;
  condition?: (typeof LISTING_CONDITIONS)[number];
  minPriceMinor?: number;
  maxPriceMinor?: number;
  inStockOnly?: boolean;
  sellerProfileId?: string;
  favoritesOnly?: boolean;
  sort?: (typeof LISTING_SORTS)[number];
}

const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
const price = (value: unknown, field = 'priceMinor') => v.int(value, field, 0, MAX_PRICE_MINOR);

const toSeller = (r: Tables<'seller_profiles'>): SellerProfile => ({
  id: r.id,
  communityId: r.community_id,
  userId: r.user_id,
  displayName: r.display_name,
  bio: r.bio,
  status: r.status as SellerProfile['status'],
  verified: r.verification_status === 'verified',
});

/** Turns listing fields into table columns (validated; the database checks the rules again). */
function columns(input: ListingPatch & { kind?: ListingKind }) {
  return {
    category_id: input.categoryId === undefined ? undefined : v.uuid(input.categoryId, 'categoryId'),
    title: input.title === undefined ? undefined : v.text(input.title, 'title', { min: 3, max: 120 }),
    description: input.description === undefined ? undefined : v.text(input.description, 'description', { min: 0, max: 5000 }),
    condition: input.condition === undefined ? undefined
      : input.condition === null ? null : v.oneOf(input.condition, 'condition', LISTING_CONDITIONS),
    pricing: input.pricing === undefined ? undefined : v.oneOf(input.pricing, 'pricing', LISTING_PRICING),
    price_minor: input.priceMinor === undefined ? undefined : input.priceMinor === null ? null : price(input.priceMinor),
    fulfillment: input.fulfillment === undefined ? undefined : v.enumList(input.fulfillment, 'fulfillment', FULFILLMENT_METHODS),
    pickup_area: input.pickupArea === undefined ? undefined : v.optionalText(input.pickupArea, 'pickupArea', { max: 120 }) ?? null,
    service_area: input.serviceArea === undefined ? undefined : v.optionalText(input.serviceArea, 'serviceArea', { max: 200 }) ?? null,
  };
}

export function marketplaceService(ctx: ServiceContext) {
  const { db } = ctx;

  /** Signed links for private listing pictures (null where a file cannot be read). */
  const signed = async (paths: (string | null)[], seconds = 3600) => {
    const unique = [...new Set(paths.filter((p): p is string => !!p))];
    const urls = new Map<string, string>();
    if (unique.length > 0) {
      const result = await db.storage.from(LISTING_IMAGES_BUCKET).createSignedUrls(unique, seconds);
      for (const item of result.data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
    }
    return (path: string | null) => (path ? (urls.get(path) ?? null) : null);
  };

  const toCards = async (rows: SearchRow[]): Promise<ListingCard[]> => {
    const url = await signed(rows.map((r) => r.cover_image_path));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as ListingKind,
      title: r.title,
      categoryName: r.category_name,
      condition: r.condition,
      pricing: r.pricing,
      priceMinor: r.price_minor,
      currency: r.currency,
      available: r.available,
      sellerProfileId: r.seller_profile_id,
      sellerName: r.seller_display_name,
      sellerVerified: r.seller_verified,
      coverUrl: url(r.cover_image_path),
      imageCount: r.image_count,
      isFavorite: r.is_favorite,
      publishedAt: r.published_at,
    }));
  };

  return {
    /** Active categories, products first, in display order. */
    categories(kind?: ListingKind): Promise<Category[]> {
      return ctx.run('marketplace.categories', async () => {
        await ctx.requireUserId();
        let query = db.from('market_categories').select('id, slug, name, kind, icon').order('sort_order');
        if (kind !== undefined) query = query.eq('kind', v.oneOf(kind, 'kind', LISTING_KINDS));
        const rows = unwrap(await query) ?? [];
        return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, kind: r.kind as ListingKind, icon: r.icon }));
      });
    },

    /** The storefront: active listings of active sellers in one community. Requires marketplace.view. */
    search(input: SearchInput): Promise<Page<ListingCard>> {
      return ctx.run('marketplace.search', async () => {
        await ctx.requireUserId();
        v.only<SearchInput>(input, 'input', ['communityId', 'query', 'categoryId', 'kind', 'condition', 'minPriceMinor',
          'maxPriceMinor', 'inStockOnly', 'sellerProfileId', 'favoritesOnly', 'sort', 'limit', 'cursor']);
        const limit = pageSize(input.limit, 50);
        const offset = (decodeCursor(input.cursor, ['int'])?.[0] as number | undefined) ?? 0;
        if (offset > 1000) throw new ServiceError(ErrorCode.Validation, 'Refine your search to see more results.', { field: 'cursor' });
        const query = input.query === undefined || input.query.trim() === '' ? undefined : v.text(input.query, 'query', { max: 100 });
        const rows = unwrap(await db.rpc('search_listings', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_query: query,
          p_category_id: input.categoryId === undefined ? undefined : v.uuid(input.categoryId, 'categoryId'),
          p_kind: input.kind === undefined ? undefined : v.oneOf(input.kind, 'kind', LISTING_KINDS),
          p_condition: input.condition === undefined ? undefined : v.oneOf(input.condition, 'condition', LISTING_CONDITIONS),
          p_min_price_minor: input.minPriceMinor === undefined ? undefined : price(input.minPriceMinor, 'minPriceMinor'),
          p_max_price_minor: input.maxPriceMinor === undefined ? undefined : price(input.maxPriceMinor, 'maxPriceMinor'),
          p_in_stock_only: input.inStockOnly === undefined ? undefined : v.bool(input.inStockOnly, 'inStockOnly'),
          p_seller_profile_id: input.sellerProfileId === undefined ? undefined : v.uuid(input.sellerProfileId, 'sellerProfileId'),
          p_favorites_only: input.favoritesOnly === undefined ? undefined : v.bool(input.favoritesOnly, 'favoritesOnly'),
          p_sort: input.sort === undefined ? (query ? 'relevance' : 'newest') : v.oneOf(input.sort, 'sort', LISTING_SORTS),
          p_limit: limit,
          p_offset: offset,
        })) ?? [];
        return {
          items: await toCards(rows),
          nextCursor: rows.length === limit && offset + limit <= 1000 ? encodeCursor([offset + limit]) : null,
        };
      });
    },

    /** One listing with its pictures, seller and stock, as the caller may see it. */
    listing(listingId: string): Promise<ListingDetail> {
      return ctx.run('marketplace.listing', async () => {
        const userId = await ctx.requireUserId();
        const id = v.uuid(listingId, 'listingId');
        const listing = unwrapOne(await db.from('listings').select('*').eq('id', id).maybeSingle(), 'Listing not found.');
        const [category, seller, images, stock, favorite] = await Promise.all([
          db.from('market_categories').select('id, slug, name, kind, icon').eq('id', listing.category_id).maybeSingle(),
          db.from('seller_profiles').select('*').eq('id', listing.seller_profile_id).maybeSingle(),
          db.from('listing_images').select('id, storage_path, position, width, height').eq('listing_id', id).order('position'),
          db.from('inventory').select('on_hand, reserved').eq('listing_id', id).maybeSingle(),
          db.from('favorites').select('listing_id').eq('listing_id', id).maybeSingle(),
        ]);
        const pictures = unwrap(images) ?? [];
        const url = await signed(pictures.map((p) => p.storage_path));
        const c = unwrap(category);
        const s = unwrap(seller);
        const inv = unwrap(stock);
        return {
          listing,
          category: c ? { id: c.id, slug: c.slug, name: c.name, kind: c.kind as ListingKind, icon: c.icon } : null,
          seller: s ? toSeller(s) : null,
          images: pictures.map((p) => ({ id: p.id, path: p.storage_path, url: url(p.storage_path), position: p.position, width: p.width, height: p.height })),
          stock: inv ? { onHand: inv.on_hand, reserved: inv.reserved, available: inv.on_hand - inv.reserved } : null,
          isFavorite: !!unwrap(favorite),
          isMine: listing.seller_user_id === userId,
        };
      });
    },

    /** The caller's seller profile in a community, or null (no shop yet). */
    mySellerProfile(communityId: string): Promise<SellerProfile | null> {
      return ctx.run('marketplace.mySellerProfile', async () => {
        const userId = await ctx.requireUserId();
        const row = unwrap(await db.from('seller_profiles').select('*')
          .eq('community_id', v.uuid(communityId, 'communityId')).eq('user_id', userId).maybeSingle());
        return row ? toSeller(row) : null;
      });
    },

    /** A seller's public profile in the current community. */
    sellerProfile(sellerProfileId: string): Promise<SellerProfile> {
      return ctx.run('marketplace.sellerProfile', async () => {
        await ctx.requireUserId();
        const row = unwrapOne(await db.from('seller_profiles').select('*')
          .eq('id', v.uuid(sellerProfileId, 'sellerProfileId')).maybeSingle(), 'Seller not found.');
        return toSeller(row);
      });
    },

    /** Opens a shop (first time) or updates its name and description. Requires marketplace.sell. */
    saveSellerProfile(communityId: string, input: { displayName: string; bio?: string | null }): Promise<SellerProfile> {
      return ctx.run('marketplace.saveSellerProfile', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['displayName', 'bio']);
        const community = v.uuid(communityId, 'communityId');
        const values = {
          display_name: v.text(input.displayName, 'displayName', { min: 1, max: 80 }),
          bio: input.bio === undefined ? undefined : v.optionalText(input.bio, 'bio', { max: 1000 }) ?? null,
        };
        const existing = unwrap(await db.from('seller_profiles').select('id').eq('community_id', community).eq('user_id', userId).maybeSingle());
        if (!existing) {
          return toSeller(unwrapOne(await db.from('seller_profiles')
            .insert({ community_id: community, ...values } as Database['public']['Tables']['seller_profiles']['Insert'])
            .select('*').maybeSingle()));
        }
        return toSeller(await mutateOne(
          () => db.from('seller_profiles').update(values).eq('id', existing.id).select('*'),
          () => db.from('seller_profiles').select('id').eq('id', existing.id),
          'Seller not found.',
        ));
      });
    },

    /** Sellers pause or resume their shop; marketplace managers suspend or reinstate it. */
    setSellerStatus(sellerProfileId: string, status: SellerProfile['status']): Promise<SellerProfile> {
      return ctx.run('marketplace.setSellerStatus', async () => {
        await ctx.requireUserId();
        const id = v.uuid(sellerProfileId, 'sellerProfileId');
        return toSeller(await mutateOne(
          () => db.from('seller_profiles').update({ status: v.oneOf(status, 'status', ['active', 'paused', 'suspended'] as const) }).eq('id', id).select('*'),
          () => db.from('seller_profiles').select('id').eq('id', id),
          'Seller not found.',
        ));
      });
    },

    /** The caller's own listings in a community (every status), newest first. */
    myListings(communityId: string): Promise<(Listing & { available: number | null; coverUrl: string | null })[]> {
      return ctx.run('marketplace.myListings', async () => {
        const userId = await ctx.requireUserId();
        const rows = unwrap(await db.from('listings').select('*, inventory(on_hand, reserved), listing_images(storage_path, position)')
          .eq('community_id', v.uuid(communityId, 'communityId')).eq('seller_user_id', userId)
          .order('created_at', { ascending: false }).limit(200)) ?? [];
        type Row = Listing & { inventory: { on_hand: number; reserved: number } | null; listing_images: { storage_path: string; position: number }[] };
        const typed = rows as unknown as Row[];
        const cover = (r: Row) => [...r.listing_images].sort((a, b) => a.position - b.position)[0]?.storage_path ?? null;
        const url = await signed(typed.map(cover));
        return typed.map(({ inventory, listing_images: _images, ...r }) => ({
          ...r,
          available: inventory ? inventory.on_hand - inventory.reserved : null,
          coverUrl: url(cover({ ...r, inventory, listing_images: _images })),
        }));
      });
    },

    /** Creates a listing under the caller's seller profile in that community (draft unless publish). */
    createListing(input: ListingInput): Promise<Listing> {
      return ctx.run('marketplace.createListing', async () => {
        const userId = await ctx.requireUserId();
        v.only<ListingInput>(input, 'input', ['communityId', 'kind', 'categoryId', 'title', 'description', 'condition',
          'pricing', 'priceMinor', 'fulfillment', 'pickupArea', 'serviceArea', 'publish']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const kind = v.oneOf(input.kind, 'kind', LISTING_KINDS);
        const seller = unwrap(await db.from('seller_profiles').select('id').eq('community_id', communityId).eq('user_id', userId).maybeSingle());
        if (!seller) throw new ServiceError(ErrorCode.Conflict, 'Open your shop before listing something.');
        const values = columns({ ...input, kind });
        return unwrapOne(await db.from('listings').insert({
          ...values,
          community_id: communityId,
          seller_profile_id: seller.id,
          kind,
          pricing: values.pricing ?? 'fixed',
          status: input.publish === true ? 'active' : 'draft',
        } as Database['public']['Tables']['listings']['Insert']).select('*').maybeSingle());
      });
    },

    updateListing(listingId: string, patch: ListingPatch): Promise<Listing> {
      return ctx.run('marketplace.updateListing', async () => {
        await ctx.requireUserId();
        v.only<ListingPatch>(patch, 'patch', ['categoryId', 'title', 'description', 'condition', 'pricing', 'priceMinor',
          'fulfillment', 'pickupArea', 'serviceArea']);
        const id = v.uuid(listingId, 'listingId');
        const values = v.nonEmptyPatch(columns(patch), 'patch');
        return mutateOne(
          () => db.from('listings').update(values).eq('id', id).select('*'),
          () => db.from('listings').select('id').eq('id', id),
          'Listing not found.',
        );
      });
    },

    /** Seller: publish, pause, resume or remove (removed is final). */
    setListingStatus(listingId: string, status: 'active' | 'paused' | 'removed'): Promise<Listing> {
      return ctx.run('marketplace.setListingStatus', async () => {
        await ctx.requireUserId();
        const id = v.uuid(listingId, 'listingId');
        const next = v.oneOf(status, 'status', ['active', 'paused', 'removed'] as const);
        return mutateOne(
          () => db.from('listings').update({ status: next }).eq('id', id).select('*'),
          () => db.from('listings').select('id').eq('id', id),
          'Listing not found.',
        );
      });
    },

    /** Marketplace managers: remove someone's listing, with a reason (audited). */
    moderateRemove(listingId: string, reason: string): Promise<Listing> {
      return ctx.run('marketplace.moderateRemove', async () => {
        await ctx.requireUserId();
        const id = v.uuid(listingId, 'listingId');
        const why = v.text(reason, 'reason', { min: 1, max: 500 });
        return mutateOne(
          () => db.from('listings').update({ status: 'removed', removal_reason: why }).eq('id', id).select('*'),
          () => db.from('listings').select('id').eq('id', id),
          'Listing not found.',
        );
      });
    },

    /** Uploads a picture to the caller's own folder of the community (private bucket). Attach it with addImage(). */
    uploadImage(input: { communityId: string; file: UploadBody; mimeType: ImageMimeType }): Promise<{ path: string }> {
      return ctx.run('marketplace.uploadImage', async () => {
        const userId = await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'file', 'mimeType']);
        const communityId = v.uuid(input.communityId, 'communityId');
        const { mimeType, ext } = checkImage(input, LISTING_IMAGE_MAX_BYTES);
        const path = `${communityId}/${userId}/${randomId()}.${ext}`;
        const stored = await db.storage.from(LISTING_IMAGES_BUCKET).upload(path, uploadBody(input.file, mimeType), { contentType: mimeType, upsert: false });
        if (stored.error) {
          const status = Number((stored.error as { statusCode?: string | number }).statusCode ?? 0);
          if (status === 403 || /row-level security|unauthorized/i.test(stored.error.message))
            throw new ServiceError(ErrorCode.Forbidden, "You can't sell in this community.", {}, stored.error);
          if (/bucket not found/i.test(stored.error.message)) throw serverOutdated(stored.error);
          throw new ServiceError(ErrorCode.ServerError, 'The picture could not be uploaded. Try again.', {}, stored.error);
        }
        return { path };
      });
    },

    /** Attaches an uploaded picture to the caller's listing, after the existing ones. */
    addImage(listingId: string, image: { path: string; width: number; height: number }): Promise<ListingImage> {
      return ctx.run('marketplace.addImage', async () => {
        await ctx.requireUserId();
        const id = v.uuid(listingId, 'listingId');
        v.only<typeof image>(image, 'image', ['path', 'width', 'height']);
        if (typeof image.path !== 'string' || !IMAGE_PATH.test(image.path)) v.fail('path', 'The picture path is invalid.');
        const listing = unwrapOne(await db.from('listings').select('id, community_id').eq('id', id).maybeSingle(), 'Listing not found.');
        const taken = (unwrap(await db.from('listing_images').select('position').eq('listing_id', id)) ?? []).map((r) => r.position);
        const position = [...Array(LISTING_MAX_IMAGES).keys()].find((p) => !taken.includes(p));
        if (position === undefined) v.fail('images', `A listing can have at most ${LISTING_MAX_IMAGES} pictures.`);
        const row = unwrapOne(await db.from('listing_images').insert({
          listing_id: id, community_id: listing.community_id, storage_path: image.path, position: position!,
          width: v.int(image.width, 'width', 1, 20_000), height: v.int(image.height, 'height', 1, 20_000),
        }).select('id, storage_path, position, width, height').maybeSingle());
        const url = await signed([row.storage_path]);
        return { id: row.id, path: row.storage_path, url: url(row.storage_path), position: row.position, width: row.width, height: row.height };
      });
    },

    /** Removes a picture from the caller's listing (the file is then purged). */
    removeImage(imageId: string): Promise<void> {
      return ctx.run('marketplace.removeImage', async () => {
        await ctx.requireUserId();
        const id = v.uuid(imageId, 'imageId');
        const row = await mutateOne(
          () => db.from('listing_images').delete().eq('id', id).select('storage_path'),
          () => db.from('listing_images').select('id').eq('id', id),
          'Picture not found.',
        );
        // Best effort: the uploader may delete a file no listing uses (else the purge job does).
        await db.storage.from(LISTING_IMAGES_BUCKET).remove([row.storage_path]);
      });
    },

    /** Sets the quantity on hand (products; seller only; never below reserved). */
    setStock(listingId: string, onHand: number, note?: string): Promise<{ onHand: number; reserved: number; available: number }> {
      return ctx.run('marketplace.setStock', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.rpc('set_listing_stock', {
          p_listing_id: v.uuid(listingId, 'listingId'),
          p_on_hand: v.int(onHand, 'onHand', 0, 1_000_000),
          p_note: v.optionalText(note, 'note', { max: 200 }) ?? undefined,
        })) ?? [];
        const r = rows[0];
        if (!r) throw new ServiceError(ErrorCode.NotFound, 'Listing not found.');
        return { onHand: r.on_hand, reserved: r.reserved, available: r.available };
      });
    },

    /** Saves (true) or unsaves (false) a listing for the caller. */
    setFavorite(listingId: string, saved: boolean): Promise<void> {
      return ctx.run('marketplace.setFavorite', async () => {
        await ctx.requireUserId();
        const id = v.uuid(listingId, 'listingId');
        if (v.bool(saved, 'saved')) {
          const { error } = await db.from('favorites').insert({ listing_id: id } as Database['public']['Tables']['favorites']['Insert']);
          // Already saved is fine.
          if (error && error.code !== '23505') unwrap({ data: null, error });
        } else {
          unwrap(await db.from('favorites').delete().eq('listing_id', id));
        }
      });
    },
  };
}

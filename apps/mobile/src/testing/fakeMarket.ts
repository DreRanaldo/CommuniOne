// The marketplace catalog (migration 32) inside the fake Supabase: categories,
// seller profiles, listings, pictures (private bucket), stock and favorites,
// with the same visibility and write rules as the database (RLS + triggers).
// Used by fakeSupabase(); tests seed it with makeSellerProfile / makeListing.

type DbError = { code: string; message: string; status?: number };
type Result = { data: unknown; error: DbError | null };
type Filter = [column: string, value: unknown];

export interface FakeSellerProfile {
  id: string;
  community_id: string;
  user_id: string;
  display_name: string;
  bio: string | null;
  status: string;
  verification_status: string;
  created_at: string;
  updated_at: string;
}

export interface FakeListing {
  id: string;
  community_id: string;
  seller_profile_id: string;
  seller_user_id: string;
  kind: string;
  category_id: string;
  title: string;
  description: string;
  condition: string | null;
  pricing: string;
  price_minor: number | null;
  currency: string;
  fulfillment: string[];
  pickup_area: string | null;
  service_area: string | null;
  status: string;
  removed_by: string | null;
  removal_reason: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  /** Seeding only: stock on hand and reserved (products), picture paths (files exist). */
  on_hand?: number;
  reserved?: number;
  images?: string[];
}

export interface FakeMarketSeed {
  sellers?: FakeSellerProfile[];
  listings?: FakeListing[];
}

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Categories as the migration seeds them (a subset; same slugs). */
export const FAKE_CATEGORIES = [
  ['electronics', 'Electronics', 'product', 'tv-outline'],
  ['furniture', 'Furniture', 'product', 'bed-outline'],
  ['fashion', 'Fashion & clothing', 'product', 'shirt-outline'],
  ['other-products', 'Other items', 'product', 'pricetag-outline'],
  ['tech-help', 'Tech help', 'service', 'laptop-outline'],
  ['cleaning', 'Cleaning', 'service', 'sparkles-outline'],
  ['other-services', 'Other services', 'service', 'construct-outline'],
].map(([slug, name, kind, icon], i) => ({
  id: uuid('c4c4c4c4', i + 1),
  slug: slug!,
  name: name!,
  kind: kind!,
  icon: icon!,
  sort_order: (i + 1) * 10,
  active: true,
}));

export const categoryId = (slug: string) => FAKE_CATEGORIES.find((c) => c.slug === slug)!.id;

export const makeSellerProfile = (
  communityId: string,
  userId: string,
  n: number,
  overrides: Partial<FakeSellerProfile> = {},
): FakeSellerProfile => ({
  id: uuid('5e5e5e5e', n),
  community_id: communityId,
  user_id: userId,
  display_name: `Shop ${n}`,
  bio: null,
  status: 'active',
  verification_status: 'unverified',
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
  ...overrides,
});

export const makeListing = (
  seller: FakeSellerProfile,
  n: number,
  overrides: Partial<FakeListing> = {},
): FakeListing => {
  const kind = overrides.kind ?? 'product';
  return {
    id: uuid('1a1a1a1a', n),
    community_id: seller.community_id,
    seller_profile_id: seller.id,
    seller_user_id: seller.user_id,
    kind,
    category_id: categoryId(kind === 'product' ? 'electronics' : 'tech-help'),
    title: `Listing ${n}`,
    description: `Description ${n}`,
    condition: kind === 'product' ? 'good' : null,
    pricing: 'fixed',
    price_minor: 100_000 * n,
    currency: 'JMD',
    fulfillment: kind === 'product' ? ['pickup'] : [],
    pickup_area: null,
    service_area: null,
    status: 'active',
    removed_by: null,
    removal_reason: null,
    published_at: new Date(Date.UTC(2026, 9, 10, 12, n)).toISOString(),
    created_at: new Date(Date.UTC(2026, 9, 10, 12, n)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 10, 12, n)).toISOString(),
    on_hand: kind === 'product' ? 5 : undefined,
    ...overrides,
  };
};

export function createFakeMarket(
  seed: FakeMarketSeed,
  deps: { me: () => string | null; permissionsIn: (communityId: string) => string[] },
) {
  const { me, permissionsIn } = deps;
  const can = (communityId: string, key: string) => permissionsIn(communityId).includes(key);
  const denied = (message: string): Result => ({ data: null, error: { code: '42501', message } });
  const invalid = (message: string): Result => ({ data: null, error: { code: '22023', message } });
  const now = () => new Date().toISOString();

  const sellers: FakeSellerProfile[] = (seed.sellers ?? []).map((s) => ({ ...s }));
  const listings: FakeListing[] = [];
  const inventory = new Map<string, { on_hand: number; reserved: number }>();
  const images: {
    id: string;
    listing_id: string;
    community_id: string;
    storage_path: string;
    position: number;
    width: number;
    height: number;
  }[] = [];
  const files = new Map<string, string>(); // listing-images path → uploader
  const favorites: { user_id: string; listing_id: string; community_id: string; created_at: string }[] = [];
  const movements: { listing_id: string; delta: number; reason: string }[] = [];
  /** Carts (migration 33): `${userId}:${communityId}` → lines. */
  const carts = new Map<
    string,
    { listing_id: string; quantity: number; seen_price_minor: number; added_at: number }[]
  >();
  let counter = 900;

  for (const seeded of seed.listings ?? []) {
    const { on_hand, reserved, images: paths, ...row } = seeded;
    listings.push({ ...row });
    if (row.kind === 'product') inventory.set(row.id, { on_hand: on_hand ?? 0, reserved: reserved ?? 0 });
    (paths ?? []).forEach((path, position) => {
      files.set(path, row.seller_user_id);
      images.push({
        id: uuid('1b1b1b1b', ++counter),
        listing_id: row.id,
        community_id: row.community_id,
        storage_path: path,
        position,
        width: 800,
        height: 600,
      });
    });
  }

  const sellerOf = (id: string) => sellers.find((s) => s.id === id);
  /** private.can_view_listing_row */
  const canView = (l: FakeListing) => {
    const user = me();
    if (!user) return false;
    if (l.seller_user_id === user)
      return can(l.community_id, 'marketplace.view') || can(l.community_id, 'marketplace.sell');
    if (can(l.community_id, 'marketplace.manage')) return l.status !== 'draft';
    return (
      l.status === 'active' &&
      can(l.community_id, 'marketplace.view') &&
      sellerOf(l.seller_profile_id)?.status === 'active'
    );
  };
  const isSeller = (l: FakeListing | undefined) =>
    !!l && l.seller_user_id === me() && can(l.community_id, 'marketplace.sell');
  const canViewSeller = (s: FakeSellerProfile) =>
    s.user_id === me() ||
    can(s.community_id, 'marketplace.manage') ||
    (s.status === 'active' && can(s.community_id, 'marketplace.view'));
  const pick = (row: Record<string, unknown>, columns: string) =>
    columns === '*' || columns.includes('(')
      ? { ...row }
      : Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()]]));
  const listingRow = ({ on_hand: _o, reserved: _r, images: _i, ...l }: FakeListing) => l;
  const categoryOk = (id: unknown, kind: string) =>
    FAKE_CATEGORIES.some((c) => c.id === id && c.kind === kind && c.active);

  /** Data API for the marketplace tables; undefined when the table is not ours. */
  function query(
    table: string,
    op: string,
    filters: Filter[],
    columns: string,
    values: Record<string, unknown> | undefined,
    single: boolean,
    matches: (row: Record<string, unknown>) => boolean,
  ): Result | undefined {
    const user = me()!;
    const out = (rows: Record<string, unknown>[]) => ({
      data: single ? (rows[0] ?? null) : rows,
      error: null,
    });
    const filterValue = (column: string) => filters.find(([c]) => c === column)?.[1];

    if (table === 'market_categories' && op === 'select')
      return out(FAKE_CATEGORIES.filter((c) => matches(c)).map((c) => pick(c, columns)));

    if (table === 'seller_profiles') {
      if (op === 'select')
        return out(
          sellers.filter((s) => canViewSeller(s) && matches({ ...s })).map((s) => pick({ ...s }, columns)),
        );
      if (op === 'insert') {
        const communityId = String(values?.community_id);
        if (!can(communityId, 'marketplace.sell'))
          return denied('new row violates row-level security policy for table "seller_profiles"');
        if (sellers.some((s) => s.community_id === communityId && s.user_id === user))
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        const row: FakeSellerProfile = {
          ...makeSellerProfile(communityId, user, ++counter),
          display_name: String(values?.display_name),
          bio: (values?.bio as string | null | undefined) ?? null,
        };
        sellers.push(row);
        return out([pick({ ...row }, columns)]);
      }
      if (op === 'update') {
        const targets = sellers.filter((s) => canViewSeller(s) && matches({ ...s }));
        const updated: FakeSellerProfile[] = [];
        for (const s of targets) {
          const own = s.user_id === user && can(s.community_id, 'marketplace.sell');
          const manager = can(s.community_id, 'marketplace.manage');
          if (!own && !manager) continue;
          const next = { ...s, ...values } as FakeSellerProfile;
          if (own) {
            if (
              next.status !== s.status &&
              (s.status === 'suspended' || !['active', 'paused'].includes(next.status))
            )
              return denied('a suspended seller profile can only be reinstated by a marketplace manager');
          } else if (
            next.display_name !== s.display_name ||
            next.bio !== s.bio ||
            !(
              (s.status !== 'suspended' && next.status === 'suspended') ||
              (s.status === 'suspended' && next.status === 'active')
            )
          )
            return denied('marketplace managers can only suspend or reinstate a seller');
          Object.assign(s, values, { updated_at: now() });
          updated.push(s);
        }
        return out(updated.map((s) => pick({ ...s }, columns)));
      }
    }

    if (table === 'listings') {
      const visible = () => listings.filter((l) => canView(l));
      if (op === 'select') {
        const rows = visible()
          .filter((l) => matches({ ...l }))
          .map((l) => {
            const row: Record<string, unknown> = { ...listingRow(l) };
            if (columns.includes('inventory(')) row.inventory = inventory.get(l.id) ?? null;
            if (columns.includes('listing_images('))
              row.listing_images = images
                .filter((i) => i.listing_id === l.id)
                .map(({ storage_path, position }) => ({ storage_path, position }));
            return pick(row, columns);
          });
        return out(rows);
      }
      if (op === 'insert') {
        const communityId = String(values?.community_id);
        if (!can(communityId, 'marketplace.sell'))
          return denied('new row violates row-level security policy for table "listings"');
        const seller = sellerOf(String(values?.seller_profile_id));
        if (!seller || seller.user_id !== user || seller.community_id !== communityId)
          return denied('listings are created under your own seller profile in that community');
        if (seller.status !== 'active') return denied(`your seller profile is ${seller.status}`);
        const kind = String(values?.kind);
        const status = String(values?.status ?? 'draft');
        if (!['draft', 'active'].includes(status)) return invalid('new listings are drafts or active');
        if (!categoryOk(values?.category_id, kind)) return invalid(`choose a ${kind} category`);
        const pricing = String(values?.pricing ?? 'fixed');
        const priceMinor = (values?.price_minor as number | null | undefined) ?? null;
        const fulfillment = (values?.fulfillment as string[] | undefined) ?? [];
        const condition = (values?.condition as string | null | undefined) ?? null;
        if (
          (kind === 'product' && (pricing !== 'fixed' || !condition || fulfillment.length === 0)) ||
          (kind === 'service' && condition) ||
          (pricing === 'quote') !== (priceMinor === null)
        )
          return {
            data: null,
            error: { code: '23514', message: 'new row violates check constraint "listings_product_rules"' },
          };
        const row: FakeListing = {
          ...makeListing(seller, ++counter, { kind }),
          category_id: String(values?.category_id),
          title: String(values?.title),
          description: String(values?.description ?? ''),
          condition,
          pricing,
          price_minor: priceMinor,
          fulfillment,
          pickup_area: (values?.pickup_area as string | null | undefined) ?? null,
          service_area: (values?.service_area as string | null | undefined) ?? null,
          status,
          published_at: status === 'active' ? now() : null,
          created_at: now(),
          updated_at: now(),
        };
        delete row.on_hand;
        listings.unshift(row);
        if (kind === 'product') inventory.set(row.id, { on_hand: 0, reserved: 0 });
        return out([pick({ ...listingRow(row) }, columns)]);
      }
      if (op === 'update') {
        const updated: FakeListing[] = [];
        for (const l of visible().filter((x) => matches({ ...x }))) {
          const own = l.seller_user_id === user && can(l.community_id, 'marketplace.sell');
          const manager = l.status !== 'draft' && can(l.community_id, 'marketplace.manage');
          if (!own && !manager) continue;
          if (l.status === 'removed') return denied('removed listings cannot be changed');
          const next = { ...l, ...values } as FakeListing;
          if (own) {
            if ('removal_reason' in (values ?? {})) return denied('only moderators record a removal reason');
            const allowed: Record<string, string[]> = {
              draft: ['active', 'removed'],
              active: ['paused', 'removed'],
              paused: ['active', 'removed'],
            };
            if (next.status !== l.status && !allowed[l.status]?.includes(next.status))
              return invalid(`invalid listing status change: ${l.status} -> ${next.status}`);
            if ('category_id' in (values ?? {}) && !categoryOk(next.category_id, l.kind))
              return invalid(`choose a ${l.kind} category`);
            if ((next.pricing === 'quote') !== (next.price_minor === null))
              return {
                data: null,
                error: { code: '23514', message: 'new row violates check constraint "listings_price_rules"' },
              };
            if (next.status === 'removed') next.removed_by = user;
            next.published_at = l.published_at ?? (next.status === 'active' ? now() : null);
          } else {
            const changedOther = Object.keys(values ?? {}).some(
              (k) => !['status', 'removal_reason'].includes(k),
            );
            if (next.status !== 'removed' || changedOther)
              return denied('marketplace managers can only remove a listing');
            if (!next.removal_reason?.trim()) return invalid('give a reason for removing this listing');
            next.removed_by = user;
          }
          Object.assign(l, next, { updated_at: now() });
          updated.push(l);
        }
        return out(updated.map((l) => pick({ ...listingRow(l) }, columns)));
      }
    }

    if (table === 'listing_images') {
      if (op === 'select')
        return out(
          images
            .filter((i) => canView(listings.find((l) => l.id === i.listing_id)!) && matches({ ...i }))
            .map((i) => pick({ ...i }, columns)),
        );
      if (op === 'insert') {
        const listing = listings.find((l) => l.id === values?.listing_id);
        if (!isSeller(listing))
          return denied('new row violates row-level security policy for table "listing_images"');
        const path = String(values?.storage_path);
        const [folderCommunity, folderUser] = path.split('/');
        if (folderCommunity !== listing!.community_id || folderUser !== listing!.seller_user_id)
          return denied("the picture must be the seller's own upload for this community");
        if (!files.has(path)) return invalid('the picture was not uploaded');
        if (images.some((i) => i.listing_id === listing!.id && i.position === values?.position))
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        const row = {
          id: uuid('1b1b1b1b', ++counter),
          listing_id: listing!.id,
          community_id: listing!.community_id,
          storage_path: path,
          position: Number(values?.position),
          width: Number(values?.width),
          height: Number(values?.height),
        };
        images.push(row);
        return out([pick({ ...row }, columns)]);
      }
      if (op === 'delete') {
        const removed = images.filter(
          (i) => matches({ ...i }) && isSeller(listings.find((l) => l.id === i.listing_id)),
        );
        for (const r of removed) images.splice(images.indexOf(r), 1);
        return out(removed.map((i) => pick({ ...i }, columns)));
      }
    }

    if (table === 'cart_items' && op === 'select') {
      const community = filterValue('community_id');
      const lines = [...carts.entries()]
        .filter(
          ([key]) => key.startsWith(`${user}:`) && (!community || key.endsWith(`:${String(community)}`)),
        )
        .flatMap(([, ls]) => ls);
      return out(lines.map((l) => pick({ ...l }, columns)));
    }

    if (table === 'inventory' && op === 'select') {
      const id = filterValue('listing_id');
      const l = listings.find((x) => x.id === id);
      const row = l && canView(l) ? inventory.get(l.id) : undefined;
      return out(row ? [pick({ listing_id: id, ...row }, columns)] : []);
    }
    if (table === 'inventory') return denied('permission denied for table inventory');

    if (table === 'favorites') {
      if (op === 'select')
        return out(
          favorites
            .filter((f) => f.user_id === user && matches({ ...f }))
            .map((f) => pick({ ...f }, columns)),
        );
      if (op === 'insert') {
        const l = listings.find((x) => x.id === values?.listing_id);
        if (!l || !canView(l))
          return denied('new row violates row-level security policy for table "favorites"');
        if (favorites.some((f) => f.user_id === user && f.listing_id === l.id))
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        favorites.push({ user_id: user, listing_id: l.id, community_id: l.community_id, created_at: now() });
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const removed = favorites.filter((f) => f.user_id === user && matches({ ...f }));
        for (const r of removed) favorites.splice(favorites.indexOf(r), 1);
        return { data: null, error: null };
      }
    }
    return undefined;
  }

  /** RPCs of migration 32; undefined when the name is not ours. */
  function rpc(name: string, args: Record<string, unknown>): Result | undefined {
    const user = me();
    if (name === 'search_listings') {
      const communityId = String(args.p_community_id);
      if (!user || !can(communityId, 'marketplace.view'))
        return denied('marketplace.view is required in this community');
      const q = (args.p_query as string | undefined)?.trim().toLowerCase();
      if (q && q.length > 100) return invalid('search text can be at most 100 characters');
      const sort = String(args.p_sort ?? 'newest');
      if (!['newest', 'price_asc', 'price_desc', 'relevance'].includes(sort))
        return invalid('unknown sort order');
      const available = (l: FakeListing) => {
        const inv = inventory.get(l.id);
        return l.kind === 'product' && inv ? inv.on_hand - inv.reserved : null;
      };
      let rows = listings.filter(
        (l) =>
          l.community_id === communityId &&
          l.status === 'active' &&
          sellerOf(l.seller_profile_id)?.status === 'active' &&
          (!q || `${l.title} ${l.description}`.toLowerCase().includes(q)) &&
          (!args.p_category_id || l.category_id === args.p_category_id) &&
          (!args.p_kind || l.kind === args.p_kind) &&
          (!args.p_condition || l.condition === args.p_condition) &&
          (args.p_min_price_minor == null || (l.price_minor ?? -1) >= Number(args.p_min_price_minor)) &&
          (args.p_max_price_minor == null ||
            (l.price_minor !== null && l.price_minor <= Number(args.p_max_price_minor))) &&
          (!args.p_in_stock_only || l.kind === 'service' || (available(l) ?? 0) > 0) &&
          (!args.p_seller_profile_id || l.seller_profile_id === args.p_seller_profile_id) &&
          (!args.p_favorites_only || favorites.some((f) => f.user_id === user && f.listing_id === l.id)),
      );
      rows = [...rows].sort((a, b) =>
        sort === 'price_asc'
          ? (a.price_minor ?? Infinity) - (b.price_minor ?? Infinity)
          : sort === 'price_desc'
            ? (b.price_minor ?? -Infinity) - (a.price_minor ?? -Infinity)
            : String(b.published_at).localeCompare(String(a.published_at)),
      );
      const offset = Number(args.p_offset ?? 0);
      const limit = Number(args.p_limit ?? 24);
      return {
        data: rows.slice(offset, offset + limit).map((l) => {
          const seller = sellerOf(l.seller_profile_id)!;
          const pics = images.filter((i) => i.listing_id === l.id).sort((a, b) => a.position - b.position);
          return {
            id: l.id,
            community_id: l.community_id,
            seller_profile_id: l.seller_profile_id,
            seller_display_name: seller.display_name,
            seller_verified: seller.verification_status === 'verified',
            kind: l.kind,
            category_id: l.category_id,
            category_name: FAKE_CATEGORIES.find((c) => c.id === l.category_id)?.name ?? '',
            title: l.title,
            condition: l.condition,
            pricing: l.pricing,
            price_minor: l.price_minor,
            currency: l.currency,
            available: available(l),
            cover_image_path: pics[0]?.storage_path ?? null,
            image_count: pics.length,
            is_favorite: favorites.some((f) => f.user_id === user && f.listing_id === l.id),
            published_at: l.published_at,
            rank: 0,
          };
        }),
        error: null,
      };
    }
    if (name === 'cart_set_item' || name === 'cart_quote' || name === 'cart_clear') {
      if (!user) return denied('authentication required');
      if (name === 'cart_clear') {
        carts.delete(`${user}:${String(args.p_community_id)}`);
        return { data: null, error: null };
      }
      if (name === 'cart_quote') {
        const communityId = String(args.p_community_id);
        if (!can(communityId, 'marketplace.buy'))
          return denied('marketplace.buy is required in this community');
        const lines = (carts.get(`${user}:${communityId}`) ?? []).map((ci) => {
          const l = listings.find((x) => x.id === ci.listing_id)!;
          const seller = sellerOf(l.seller_profile_id)!;
          const inv = inventory.get(l.id);
          const available = Math.max(inv ? inv.on_hand - inv.reserved : 0, 0);
          const issue =
            l.status !== 'active' || seller.status !== 'active' || !canView(l)
              ? 'unavailable'
              : available <= 0
                ? 'out_of_stock'
                : available < ci.quantity
                  ? 'insufficient_stock'
                  : l.price_minor !== ci.seen_price_minor
                    ? 'price_changed'
                    : null;
          const counts = issue === null || issue === 'price_changed';
          return {
            listing_id: l.id,
            seller_profile_id: l.seller_profile_id,
            seller_display_name: seller.display_name,
            title: l.title,
            cover_image_path:
              images.filter((i) => i.listing_id === l.id).sort((a, b) => a.position - b.position)[0]
                ?.storage_path ?? null,
            unit_price_minor: l.price_minor,
            seen_price_minor: ci.seen_price_minor,
            currency: l.currency,
            quantity: ci.quantity,
            available,
            fulfillment: l.fulfillment,
            line_total_minor: counts ? (l.price_minor ?? 0) * ci.quantity : 0,
            issue,
          };
        });
        const subtotal = lines.reduce((sum, l) => sum + l.line_total_minor, 0);
        const count = lines.reduce((sum, l) => sum + l.quantity, 0);
        return {
          data: lines.map((l) => ({ ...l, subtotal_minor: subtotal, item_count: count })),
          error: null,
        };
      }
      const quantity = Number(args.p_quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99)
        return invalid('quantity must be between 0 and 99');
      const l = listings.find((x) => x.id === args.p_listing_id);
      if (!l || !canView(l)) return { data: null, error: { code: 'P0002', message: 'listing not found' } };
      if (!can(l.community_id, 'marketplace.buy'))
        return denied('marketplace.buy is required in this community');
      const key = `${user}:${l.community_id}`;
      const lines = carts.get(key) ?? [];
      if (quantity === 0) {
        carts.set(
          key,
          lines.filter((x) => x.listing_id !== l.id),
        );
        return { data: 0, error: null };
      }
      if (l.seller_user_id === user) return invalid('you cannot buy your own listing');
      if (l.kind !== 'product' || l.price_minor === null)
        return invalid('services are booked, not added to the cart');
      if (l.status !== 'active' || sellerOf(l.seller_profile_id)?.status !== 'active')
        return invalid('this listing is not for sale right now');
      const inv = inventory.get(l.id);
      const available = inv ? inv.on_hand - inv.reserved : 0;
      if (available < quantity) return invalid(`only ${Math.max(available, 0)} available`);
      const existing = lines.find((x) => x.listing_id === l.id);
      if (existing) Object.assign(existing, { quantity, seen_price_minor: l.price_minor });
      else lines.push({ listing_id: l.id, quantity, seen_price_minor: l.price_minor, added_at: Date.now() });
      carts.set(key, lines);
      return { data: quantity, error: null };
    }
    if (name === 'set_listing_stock') {
      const l = listings.find((x) => x.id === args.p_listing_id);
      if (!l || !isSeller(l)) return { data: null, error: { code: 'P0002', message: 'listing not found' } };
      if (l.kind !== 'product') return invalid('only products have stock');
      if (l.status === 'removed') return denied('removed listings cannot be changed');
      const onHand = Number(args.p_on_hand);
      const inv = inventory.get(l.id)!;
      if (!Number.isInteger(onHand) || onHand < 0 || onHand > 1_000_000)
        return invalid('stock must be between 0 and 1000000');
      if (onHand < inv.reserved)
        return invalid(`stock cannot go below the ${inv.reserved} reserved by orders in progress`);
      if (onHand !== inv.on_hand)
        movements.push({ listing_id: l.id, delta: onHand - inv.on_hand, reason: 'adjustment' });
      inv.on_hand = onHand;
      return {
        data: [
          { listing_id: l.id, on_hand: onHand, reserved: inv.reserved, available: onHand - inv.reserved },
        ],
        error: null,
      };
    }
    return undefined;
  }

  /** The private listing-images bucket (own-folder uploads with marketplace.sell). */
  const bucket = {
    upload: jest.fn(async (path: string, _body: unknown, _options?: unknown) => {
      const user = me();
      const [communityId, owner] = path.split('/');
      if (!user || owner !== user || !can(communityId ?? '', 'marketplace.sell'))
        return {
          data: null,
          error: { message: 'new row violates row-level security policy', statusCode: '403' },
        };
      files.set(path, user);
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      for (const path of paths)
        if (files.get(path) === me() && !images.some((i) => i.storage_path === path)) files.delete(path);
      return { data: [], error: null };
    }),
    createSignedUrls: jest.fn(async (paths: string[], seconds: number) => ({
      data: paths.map((path) => {
        const used = images.find((i) => i.storage_path === path);
        const listing = used && listings.find((l) => l.id === used.listing_id);
        const readable = files.has(path) && ((listing && canView(listing)) || files.get(path) === me());
        return readable
          ? { path, signedUrl: `https://storage.test/listing-images/${path}?expires=${seconds}`, error: null }
          : { path, signedUrl: '', error: 'Object not found' };
      }),
      error: null,
    })),
  };

  return {
    query,
    rpc,
    bucket,
    state: { sellers, listings, inventory, images, files, favorites, movements, carts },
  };
}

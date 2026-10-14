// Shopping cart (Stage C, migration 33): one cart per buyer per community.
// The cart stores listings and quantities only. Every price, availability
// and total comes from cart_quote() on the server; nothing here computes
// money that is charged.

import { unwrap, type ServiceContext } from '../core/context.ts';
import { LISTING_IMAGES_BUCKET } from '../marketplace/index.ts';
import * as v from '../core/validate.ts';

export const CART_MAX_QUANTITY = 99;

export type CartIssue = 'unavailable' | 'out_of_stock' | 'insufficient_stock' | 'price_changed';

export interface CartLine {
  listingId: string;
  sellerProfileId: string;
  sellerName: string;
  title: string;
  coverUrl: string | null;
  unitPriceMinor: number | null;
  seenPriceMinor: number;
  currency: string;
  quantity: number;
  available: number;
  fulfillment: string[];
  /** 0 when the line cannot be bought right now. */
  lineTotalMinor: number;
  issue: CartIssue | null;
}

export interface CartQuote {
  lines: CartLine[];
  /** Lines grouped by seller, in display order. */
  sellers: { sellerProfileId: string; sellerName: string; lines: CartLine[]; subtotalMinor: number }[];
  subtotalMinor: number;
  itemCount: number;
  currency: string;
  /** True when every line can be bought as it is. Price changes are allowed but flagged. */
  ready: boolean;
}

export function cartService(ctx: ServiceContext) {
  const { db } = ctx;

  return {
    /** The cart as the server prices it now. Requires marketplace.buy. */
    quote(communityId: string): Promise<CartQuote> {
      return ctx.run('cart.quote', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.rpc('cart_quote', { p_community_id: v.uuid(communityId, 'communityId') })) ?? [];
        const paths = [...new Set(rows.map((r) => r.cover_image_path).filter((p): p is string => !!p))];
        const urls = new Map<string, string>();
        if (paths.length > 0) {
          const signed = await db.storage.from(LISTING_IMAGES_BUCKET).createSignedUrls(paths, 3600);
          for (const item of signed.data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
        }
        const lines: CartLine[] = rows.map((r) => ({
          listingId: r.listing_id,
          sellerProfileId: r.seller_profile_id,
          sellerName: r.seller_display_name,
          title: r.title,
          coverUrl: r.cover_image_path ? (urls.get(r.cover_image_path) ?? null) : null,
          unitPriceMinor: r.unit_price_minor,
          seenPriceMinor: r.seen_price_minor,
          currency: r.currency,
          quantity: r.quantity,
          available: r.available,
          fulfillment: r.fulfillment,
          lineTotalMinor: r.line_total_minor,
          issue: (r.issue as CartIssue | null) ?? null,
        }));
        const sellers: CartQuote['sellers'] = [];
        for (const line of lines) {
          let group = sellers.find((s) => s.sellerProfileId === line.sellerProfileId);
          if (!group) {
            group = { sellerProfileId: line.sellerProfileId, sellerName: line.sellerName, lines: [], subtotalMinor: 0 };
            sellers.push(group);
          }
          group.lines.push(line);
          group.subtotalMinor += line.lineTotalMinor; // display grouping of server line totals
        }
        return {
          lines,
          sellers,
          subtotalMinor: rows[0]?.subtotal_minor ?? 0,
          itemCount: rows[0]?.item_count ?? 0,
          currency: rows[0]?.currency ?? 'JMD',
          ready: lines.length > 0 && lines.every((l) => l.issue === null || l.issue === 'price_changed'),
        };
      });
    },

    /** Sets a line's quantity (0 removes it). The server checks stock, ownership and permissions. */
    setQuantity(listingId: string, quantity: number): Promise<number> {
      return ctx.run('cart.setQuantity', async () => {
        await ctx.requireUserId();
        return unwrap(await db.rpc('cart_set_item', {
          p_listing_id: v.uuid(listingId, 'listingId'),
          p_quantity: v.int(quantity, 'quantity', 0, CART_MAX_QUANTITY),
        })) as number;
      });
    },

    remove(listingId: string): Promise<void> {
      return ctx.run('cart.remove', async () => {
        await ctx.requireUserId();
        unwrap(await db.rpc('cart_set_item', { p_listing_id: v.uuid(listingId, 'listingId'), p_quantity: 0 }));
      });
    },

    clear(communityId: string): Promise<void> {
      return ctx.run('cart.clear', async () => {
        await ctx.requireUserId();
        unwrap(await db.rpc('cart_clear', { p_community_id: v.uuid(communityId, 'communityId') }));
      });
    },

    /** Number of items in the cart (for the badge); 0 without a cart. */
    count(communityId: string): Promise<number> {
      return ctx.run('cart.count', async () => {
        await ctx.requireUserId();
        const rows = unwrap(await db.from('cart_items').select('quantity').eq('community_id', v.uuid(communityId, 'communityId'))) ?? [];
        return rows.reduce((sum, r) => sum + r.quantity, 0);
      });
    },
  };
}

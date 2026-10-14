// Checkout and orders (Stage D, migration 34): saved addresses, seller
// delivery options, server-priced checkout (preview / create / cancel), and
// the buyer's orders. Every amount comes from the database; the app only
// sends choices (pickup or delivery per seller, an address id) and the total
// it showed, which the server must match before it creates anything.

import { mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { ErrorCode, ServiceError } from '../core/errors.ts';
import { randomId } from '../core/files.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export const PARISHES = [
  'Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann', 'Trelawny', 'St. James',
  'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester', 'Clarendon', 'St. Catherine',
] as const;
export type Parish = (typeof PARISHES)[number];
export const FULFILLMENT = ['pickup', 'seller_delivery'] as const;
export type Fulfillment = (typeof FULFILLMENT)[number];
/** The order terms the buyer accepts (owner to publish the wording: decisions D6, D9). */
export const ORDER_TERMS_VERSION = '2026-10-v1';

export type Address = Tables<'addresses'>;
export type DeliveryOption = Tables<'delivery_options'>;
export type Checkout = Tables<'checkouts'>;
export type Order = Tables<'orders'>;
export type OrderItem = Tables<'order_items'>;
export type OrderEvent = Tables<'order_events'>;
export type OrderShipment = Tables<'order_shipments'>;

export interface AddressInput {
  label?: string | null;
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  town: string;
  parish: Parish;
  instructions?: string | null;
  isDefault?: boolean;
}

export interface PreviewLine {
  listingId: string;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  taxMinor: number;
  fulfillment: Fulfillment[];
  issue: string | null;
}

export interface PreviewSeller {
  sellerProfileId: string;
  sellerName: string;
  method: Fulfillment | null;
  subtotalMinor: number;
  deliveryMinor: number;
  taxMinor: number;
  totalMinor: number;
  lines: PreviewLine[];
  /** Pickup / delivery as every item of this seller allows. */
  methods: Fulfillment[];
  deliveryAvailable: boolean;
  deliveryFeeMinor: number | null;
  estimatedDays: { min: number | null; max: number | null } | null;
}

export interface CheckoutPreview {
  currency: string;
  sellers: PreviewSeller[];
  subtotalMinor: number;
  deliveryMinor: number;
  taxMinor: number;
  discountMinor: number;
  totalMinor: number;
  taxRateBps: number;
  problems: { problem: string; listingId?: string; sellerProfileId?: string }[];
}

export interface CheckoutInput {
  communityId: string;
  /** One per "Place order" tap; retries reuse it (idempotency). */
  clientRequestId: string;
  choices: { sellerProfileId: string; method: Fulfillment }[];
  addressId?: string | null;
  contactName: string;
  contactPhone: string;
  /** The total the buyer saw in the preview; the server refuses any other. */
  expectedTotalMinor: number;
}

export interface OrderDetail {
  order: Order;
  items: OrderItem[];
  events: OrderEvent[];
  checkout: Checkout | null;
  /** The caller's role in this order. */
  role: 'buyer' | 'seller';
  /** What the seller recorded about the delivery (no invented tracking). */
  shipment: OrderShipment | null;
  /** The buyer's pickup code (buyer only, once the order is ready). */
  pickupCode: string | null;
}

const PHONE = /^\+?[0-9 ()-]{7,20}$/;

type Raw = Record<string, unknown>;
const num = (x: unknown) => Number(x ?? 0);

function toPreview(doc: Raw): CheckoutPreview {
  const sellers = (doc.sellers as Raw[] | null ?? []).map((s) => {
    const lines = (s.lines as Raw[] | null ?? []).map((l) => ({
      listingId: String(l.listing_id),
      title: String(l.title),
      quantity: num(l.quantity),
      unitPriceMinor: num(l.unit_price_minor),
      lineTotalMinor: num(l.line_total_minor),
      taxMinor: num(l.tax_minor),
      fulfillment: (l.fulfillment as Fulfillment[] | null) ?? [],
      issue: (l.issue as string | null) ?? null,
    }));
    const methods = FULFILLMENT.filter((m) => lines.every((l) => l.fulfillment.includes(m)));
    return {
      sellerProfileId: String(s.seller_profile_id),
      sellerName: String(s.seller_name),
      method: (s.method as Fulfillment | null) ?? null,
      subtotalMinor: num(s.subtotal_minor),
      deliveryMinor: num(s.delivery_minor),
      taxMinor: num(s.tax_minor),
      totalMinor: num(s.total_minor),
      lines,
      methods,
      deliveryAvailable: s.delivery_available === true,
      deliveryFeeMinor: s.delivery_fee_minor == null ? null : num(s.delivery_fee_minor),
      estimatedDays: s.estimated_days_min == null && s.estimated_days_max == null ? null
        : { min: (s.estimated_days_min as number | null) ?? null, max: (s.estimated_days_max as number | null) ?? null },
    };
  });
  return {
    currency: String(doc.currency ?? 'JMD'),
    sellers,
    subtotalMinor: num(doc.subtotal_minor),
    deliveryMinor: num(doc.delivery_minor),
    taxMinor: num(doc.tax_minor),
    discountMinor: num(doc.discount_minor),
    totalMinor: num(doc.total_minor),
    taxRateBps: num(doc.tax_rate_bps),
    problems: (doc.problems as Raw[] | null ?? []).map((p) => ({
      problem: String(p.problem),
      listingId: p.listing_id ? String(p.listing_id) : undefined,
      sellerProfileId: p.seller_profile_id ? String(p.seller_profile_id) : undefined,
    })),
  };
}

const choicesJson = (choices: CheckoutInput['choices']) => {
  if (!Array.isArray(choices) || choices.length > 50) v.fail('choices', 'Choose pickup or delivery for each seller.');
  return choices.map((c, i) => {
    v.only<CheckoutInput['choices'][number]>(c, `choices[${i}]`, ['sellerProfileId', 'method']);
    return { seller_profile_id: v.uuid(c.sellerProfileId, 'sellerProfileId'), method: v.oneOf(c.method, 'method', FULFILLMENT) };
  });
};

function addressColumns(input: Partial<AddressInput>) {
  return {
    label: input.label === undefined ? undefined : v.optionalText(input.label, 'label', { max: 40 }) ?? null,
    recipient_name: input.recipientName === undefined ? undefined : v.text(input.recipientName, 'recipientName', { max: 120 }),
    phone: input.phone === undefined ? undefined
      : v.text(input.phone, 'phone', { max: 20, pattern: PHONE, patternMessage: 'Enter a phone number like 876 555 0101.' }),
    line1: input.line1 === undefined ? undefined : v.text(input.line1, 'line1', { max: 200 }),
    line2: input.line2 === undefined ? undefined : v.optionalText(input.line2, 'line2', { max: 200 }) ?? null,
    town: input.town === undefined ? undefined : v.text(input.town, 'town', { max: 80 }),
    parish: input.parish === undefined ? undefined : v.oneOf(input.parish, 'parish', PARISHES),
    instructions: input.instructions === undefined ? undefined : v.optionalText(input.instructions, 'instructions', { max: 300 }) ?? null,
    is_default: input.isDefault === undefined ? undefined : v.bool(input.isDefault, 'isDefault'),
  };
}

export function ordersService(ctx: ServiceContext) {
  const { db } = ctx;
  type StepFn = 'order_accept' | 'order_reject' | 'order_start_processing' | 'order_ready_for_pickup' | 'order_dispatch'
    | 'order_mark_delivered' | 'order_mark_delivery_failed' | 'order_seller_cancel' | 'order_buyer_cancel' | 'order_confirm_received';
  // Arguments are validated inside run(), so a bad input is a rejected promise.
  const step = (operation: string, fn: StepFn, args: () => Record<string, unknown>) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      unwrap(await db.rpc(fn, args() as never));
    });

  return {
    // ---- Addresses (owner-only) ----
    addresses(): Promise<Address[]> {
      return ctx.run('orders.addresses', async () => {
        await ctx.requireUserId();
        return unwrap(await db.from('addresses').select('*').order('is_default', { ascending: false }).order('created_at')) ?? [];
      });
    },

    saveAddress(input: AddressInput & { id?: string }): Promise<Address> {
      return ctx.run('orders.saveAddress', async () => {
        await ctx.requireUserId();
        v.only<AddressInput & { id?: string }>(input, 'input', ['id', 'label', 'recipientName', 'phone', 'line1', 'line2', 'town', 'parish', 'instructions', 'isDefault']);
        if (input.id) {
          const id = v.uuid(input.id, 'id');
          return mutateOne(
            () => db.from('addresses').update(addressColumns(input)).eq('id', id).select('*'),
            () => db.from('addresses').select('id').eq('id', id),
            'Address not found.',
          );
        }
        return unwrapOne(await db.from('addresses')
          .insert(addressColumns(input) as Database['public']['Tables']['addresses']['Insert']).select('*').maybeSingle());
      });
    },

    removeAddress(addressId: string): Promise<void> {
      return ctx.run('orders.removeAddress', async () => {
        await ctx.requireUserId();
        const id = v.uuid(addressId, 'addressId');
        await mutateOne(
          () => db.from('addresses').delete().eq('id', id).select('id'),
          () => db.from('addresses').select('id').eq('id', id),
          'Address not found.',
        );
      });
    },

    // ---- Seller delivery options ----
    deliveryOption(sellerProfileId: string): Promise<DeliveryOption | null> {
      return ctx.run('orders.deliveryOption', async () => {
        await ctx.requireUserId();
        return unwrap(await db.from('delivery_options').select('*').eq('seller_profile_id', v.uuid(sellerProfileId, 'sellerProfileId')).maybeSingle());
      });
    },

    /** The shop owner's delivery offer: fee, parishes (empty = all), optional estimate. */
    saveDeliveryOption(input: {
      sellerProfileId: string; communityId: string; feeMinor: number; parishes: Parish[];
      estimatedDaysMin?: number | null; estimatedDaysMax?: number | null; active: boolean;
    }): Promise<DeliveryOption> {
      return ctx.run('orders.saveDeliveryOption', async () => {
        await ctx.requireUserId();
        const sellerProfileId = v.uuid(input.sellerProfileId, 'sellerProfileId');
        const values = {
          fee_minor: v.int(input.feeMinor, 'feeMinor', 0, 100_000_000),
          // An empty list means every parish.
          parishes: Array.isArray(input.parishes) && input.parishes.length === 0 ? [] : v.enumList(input.parishes, 'parishes', PARISHES),
          estimated_days_min: input.estimatedDaysMin == null ? null : v.int(input.estimatedDaysMin, 'estimatedDaysMin', 0, 60),
          estimated_days_max: input.estimatedDaysMax == null ? null : v.int(input.estimatedDaysMax, 'estimatedDaysMax', 0, 60),
          active: v.bool(input.active, 'active'),
        };
        const existing = unwrap(await db.from('delivery_options').select('seller_profile_id').eq('seller_profile_id', sellerProfileId).maybeSingle());
        if (existing) {
          return mutateOne(
            () => db.from('delivery_options').update(values).eq('seller_profile_id', sellerProfileId).select('*'),
            () => db.from('delivery_options').select('seller_profile_id').eq('seller_profile_id', sellerProfileId),
            'Delivery option not found.',
          );
        }
        return unwrapOne(await db.from('delivery_options').insert({
          ...values, seller_profile_id: sellerProfileId, community_id: v.uuid(input.communityId, 'communityId'),
        }).select('*').maybeSingle());
      });
    },

    // ---- Checkout ----
    /** Prices the cart with the given choices. Problems list what blocks checkout. */
    preview(communityId: string, choices: CheckoutInput['choices'] = [], addressId?: string | null): Promise<CheckoutPreview> {
      return ctx.run('orders.preview', async () => {
        await ctx.requireUserId();
        const doc = unwrap(await db.rpc('checkout_preview', {
          p_community_id: v.uuid(communityId, 'communityId'),
          p_choices: choicesJson(choices),
          p_address_id: addressId ? v.uuid(addressId, 'addressId') : undefined,
        }));
        return toPreview((doc ?? {}) as Raw);
      });
    },

    /** A new idempotency key for one "Place order" action. */
    newRequestId: () => randomId(),

    /** Creates the checkout and seller orders (awaiting payment). Returns the checkout id. */
    create(input: CheckoutInput): Promise<string> {
      return ctx.run('orders.create', async () => {
        await ctx.requireUserId();
        v.only<CheckoutInput>(input, 'input', ['communityId', 'clientRequestId', 'choices', 'addressId', 'contactName', 'contactPhone', 'expectedTotalMinor']);
        const id = unwrap(await db.rpc('checkout_create', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_client_request_id: v.uuid(input.clientRequestId, 'clientRequestId'),
          p_choices: choicesJson(input.choices),
          p_address_id: (input.addressId ? v.uuid(input.addressId, 'addressId') : null) as string, // null: pickup only
          p_contact_name: v.text(input.contactName, 'contactName', { max: 120 }),
          p_contact_phone: v.text(input.contactPhone, 'contactPhone', { max: 20, pattern: PHONE, patternMessage: 'Enter a phone number like 876 555 0101.' }),
          p_expected_total_minor: v.int(input.expectedTotalMinor, 'expectedTotalMinor', 0, Number.MAX_SAFE_INTEGER),
          p_terms_version: ORDER_TERMS_VERSION,
        }));
        if (typeof id !== 'string') throw new ServiceError(ErrorCode.ServerError, 'The order could not be placed.');
        return id;
      });
    },

    cancelCheckout(checkoutId: string): Promise<void> {
      return ctx.run('orders.cancelCheckout', async () => {
        await ctx.requireUserId();
        unwrap(await db.rpc('checkout_cancel', { p_checkout_id: v.uuid(checkoutId, 'checkoutId') }));
      });
    },

    /** A checkout with its seller orders (buyer only). */
    checkout(checkoutId: string): Promise<{ checkout: Checkout; orders: Order[] }> {
      return ctx.run('orders.checkout', async () => {
        await ctx.requireUserId();
        const id = v.uuid(checkoutId, 'checkoutId');
        const checkout = unwrapOne(await db.from('checkouts').select('*').eq('id', id).maybeSingle(), 'Order not found.');
        const orders = unwrap(await db.from('orders').select('*').eq('checkout_id', id).order('seller_name')) ?? [];
        return { checkout, orders };
      });
    },

    // ---- Orders ----
    /** The caller's orders as a buyer in one community, newest first. */
    myOrders(input: { communityId: string } & PageRequest): Promise<Page<Order & { items: OrderItem[] }>> {
      return ctx.run('orders.myOrders', async () => {
        const userId = await ctx.requireUserId();
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        let query = db.from('orders').select('*, order_items(*)')
          .eq('community_id', v.uuid(input.communityId, 'communityId')).eq('buyer_user_id', userId)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
        if (cursor) {
          const [at, id] = cursor as [string, string];
          query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
        }
        const rows = (unwrap(await query) ?? []) as unknown as (Order & { order_items: OrderItem[] })[];
        return toPage(rows.map(({ order_items, ...o }) => ({ ...o, items: order_items })), limit, (last) => [last.created_at, last.id]);
      });
    },

    /** Orders for the caller's listings (as a seller) in one community, newest first. */
    sellerOrders(input: { communityId: string; status?: string[] } & PageRequest): Promise<Page<Order & { items: OrderItem[] }>> {
      return ctx.run('orders.sellerOrders', async () => {
        const userId = await ctx.requireUserId();
        const limit = pageSize(input.limit);
        const cursor = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        let query = db.from('orders').select('*, order_items(*)')
          .eq('community_id', v.uuid(input.communityId, 'communityId')).eq('seller_user_id', userId)
          .neq('status', 'pending_payment')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
        if (input.status?.length) query = query.in('status', input.status.map((s, i) => v.text(s, `status[${i}]`, { max: 40 })));
        if (cursor) {
          const [at, id] = cursor as [string, string];
          query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
        }
        const rows = (unwrap(await query) ?? []) as unknown as (Order & { order_items: OrderItem[] })[];
        return toPage(rows.map(({ order_items, ...o }) => ({ ...o, items: order_items })), limit, (last) => [last.created_at, last.id]);
      });
    },

    /** One order with items and history, for its buyer or seller. */
    order(orderId: string): Promise<OrderDetail> {
      return ctx.run('orders.order', async () => {
        const userId = await ctx.requireUserId();
        const id = v.uuid(orderId, 'orderId');
        const order = unwrapOne(await db.from('orders').select('*').eq('id', id).maybeSingle(), 'Order not found.');
        const buyer = order.buyer_user_id === userId;
        const [items, events, checkout, shipment, code] = await Promise.all([
          db.from('order_items').select('*').eq('order_id', id),
          db.from('order_events').select('*').eq('order_id', id).order('created_at'),
          db.from('checkouts').select('*').eq('id', order.checkout_id).maybeSingle(),
          db.from('order_shipments').select('*').eq('order_id', id).maybeSingle(),
          buyer
            ? db.from('order_pickup_codes').select('code, used_at').eq('order_id', id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        const pickup = unwrap(code) as { code: string; used_at: string | null } | null;
        return {
          order,
          items: unwrap(items) ?? [],
          events: unwrap(events) ?? [],
          checkout: unwrap(checkout),
          role: buyer ? 'buyer' : 'seller',
          shipment: unwrap(shipment),
          pickupCode: pickup && !pickup.used_at ? pickup.code : null,
        };
      });
    },

    // ---- Fulfillment (Stages G-H): every step is checked by the server ----
    /** Seller: accept a paid order. */
    accept(orderId: string): Promise<void> {
      return step('orders.accept', 'order_accept', () => ({ p_order_id: v.uuid(orderId, 'orderId') }));
    },
    /** Seller: decline a paid order; the buyer is refunded in full and the stock returns. */
    reject(orderId: string, reason: string): Promise<void> {
      return step('orders.reject', 'order_reject', () => ({ p_order_id: v.uuid(orderId, 'orderId'), p_reason: v.text(reason, 'reason', { min: 3, max: 500 }) }));
    },
    startProcessing(orderId: string): Promise<void> {
      return step('orders.startProcessing', 'order_start_processing', () => ({ p_order_id: v.uuid(orderId, 'orderId') }));
    },
    /** Seller (pickup orders): ready; the buyer receives a pickup code. */
    readyForPickup(orderId: string, note?: string | null): Promise<void> {
      return step('orders.readyForPickup', 'order_ready_for_pickup', () => ({
        p_order_id: v.uuid(orderId, 'orderId'), p_note: v.optionalText(note, 'note', { max: 500 }) ?? undefined,
      }));
    },
    /** Seller: completes a pickup with the buyer's code. */
    confirmPickup(orderId: string, code: string): Promise<'completed' | 'wrong_code'> {
      return ctx.run('orders.confirmPickup', async () => {
        await ctx.requireUserId();
        const result = unwrap(await db.rpc('order_confirm_pickup', {
          p_order_id: v.uuid(orderId, 'orderId'),
          p_code: v.text(code, 'code', { max: 6, pattern: /^[0-9]{6}$/, patternMessage: 'Enter the 6-digit code.' }),
        }));
        return result === 'completed' ? 'completed' : 'wrong_code';
      });
    },
    /** Seller (delivery orders): sent, with the courier's details if any. */
    dispatch(orderId: string, details: { courierName?: string | null; trackingReference?: string | null; trackingUrl?: string | null } = {}): Promise<void> {
      return step('orders.dispatch', 'order_dispatch', () => ({
        p_order_id: v.uuid(orderId, 'orderId'),
        p_courier_name: v.optionalText(details.courierName, 'courierName', { max: 80 }) ?? undefined,
        p_tracking_reference: v.optionalText(details.trackingReference, 'trackingReference', { max: 120 }) ?? undefined,
        p_tracking_url: v.optionalText(details.trackingUrl, 'trackingUrl', { max: 500, pattern: /^https:\/\/\S{4,}$/, patternMessage: 'A tracking link must start with https://' }) ?? undefined,
      }));
    },
    markDelivered(orderId: string): Promise<void> {
      return step('orders.markDelivered', 'order_mark_delivered', () => ({ p_order_id: v.uuid(orderId, 'orderId') }));
    },
    markDeliveryFailed(orderId: string, reason: string): Promise<void> {
      return step('orders.markDeliveryFailed', 'order_mark_delivery_failed', () => ({ p_order_id: v.uuid(orderId, 'orderId'), p_reason: v.text(reason, 'reason', { min: 3, max: 500 }) }));
    },
    /** Seller: cannot complete an accepted order; the buyer is refunded in full. */
    sellerCancel(orderId: string, reason: string): Promise<void> {
      return step('orders.sellerCancel', 'order_seller_cancel', () => ({ p_order_id: v.uuid(orderId, 'orderId'), p_reason: v.text(reason, 'reason', { min: 3, max: 500 }) }));
    },
    /** Buyer: cancel a paid order before the seller accepts it (full refund). */
    buyerCancel(orderId: string, reason?: string | null): Promise<void> {
      return step('orders.buyerCancel', 'order_buyer_cancel', () => ({ p_order_id: v.uuid(orderId, 'orderId'), p_reason: v.optionalText(reason, 'reason', { max: 500 }) ?? undefined }));
    },
    /** Buyer: confirm a delivered order arrived. */
    confirmReceived(orderId: string): Promise<void> {
      return step('orders.confirmReceived', 'order_confirm_received', () => ({ p_order_id: v.uuid(orderId, 'orderId') }));
    },
  };
}

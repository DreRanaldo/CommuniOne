// Cart, checkout, payment and orders (Stages C-E) through the whole app.
// The cart runs on the fake backend (fakeMarket.ts mirrors migration 33).
// Checkout, payment and orders stub the service methods: their rules
// (server pricing, idempotency, reservations, signed webhooks, privacy)
// are tested against the real database in supabase/tests/database/034-035
// and tests/services/{checkout,payments}.test.ts. These tests check what
// the app sends and that it only shows what the server says.
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import type {
  CheckoutPaymentState,
  CheckoutPreview,
  Order,
  OrderDetail,
  OrderItem,
  Refund,
  Booking,
} from '@communione/services';
import { makeSession, OTHER_USER_ID, sampleCommunities, TEST_USER_ID } from '@/testing/fakeSupabase';
import { categoryId, makeListing, makeSellerProfile } from '@/testing/fakeMarket';
import { renderApp } from '@/testing/render';
import { estimateText, orderStatusLabel, problemText } from './orderRules';
import { localToIso, nextDates, startTimes } from './bookingRules';

afterEach(() => jest.restoreAllMocks());

const choir = sampleCommunities[1]!;
const C = choir.community_id;
const grace = makeSellerProfile(C, OTHER_USER_ID, 1, { display_name: 'Grace Goods' });
const laptop = makeListing(grace, 1, { title: 'Used laptop', price_minor: 4_500_000, on_hand: 3 });
const tutoring = makeListing(grace, 2, {
  kind: 'service',
  title: 'Maths tutoring',
  category_id: categoryId('cleaning'),
  pricing: 'hourly',
  price_minor: 300_000,
});
const CHECKOUT = '0c000000-0000-4000-8000-000000000001';
const ORDER = '0d000000-0000-4000-8000-000000000001';
const ADDRESS = '0a000000-0000-4000-8000-000000000001';

async function openMarket(communities: unknown[] = [choir]) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: communities as never,
    market: { sellers: [{ ...grace }], listings: [{ ...laptop }, { ...tutoring }] },
  });
  await user.press(await screen.findByRole('button', { name: /^Market/ }));
  await screen.findByTestId('market-screen');
  return { user, ...app };
}

const preview = (
  over: Partial<CheckoutPreview> = {},
  method: 'pickup' | 'seller_delivery' | null = null,
): CheckoutPreview => ({
  currency: 'JMD',
  sellers: [
    {
      sellerProfileId: grace.id,
      sellerName: 'Grace Goods',
      method,
      subtotalMinor: 4_500_000,
      deliveryMinor: method === 'seller_delivery' ? 50_000 : 0,
      taxMinor: 0,
      totalMinor: 4_500_000 + (method === 'seller_delivery' ? 50_000 : 0),
      lines: [
        {
          listingId: laptop.id,
          title: 'Used laptop',
          quantity: 1,
          unitPriceMinor: 4_500_000,
          lineTotalMinor: 4_500_000,
          taxMinor: 0,
          fulfillment: ['pickup', 'seller_delivery'],
          issue: null,
        },
      ],
      methods: ['pickup', 'seller_delivery'],
      deliveryAvailable: true,
      deliveryFeeMinor: 50_000,
      estimatedDays: { min: 1, max: 2 },
    },
  ],
  subtotalMinor: 4_500_000,
  deliveryMinor: method === 'seller_delivery' ? 50_000 : 0,
  taxMinor: 0,
  discountMinor: 0,
  totalMinor: 4_500_000 + (method === 'seller_delivery' ? 50_000 : 0),
  taxRateBps: 1500,
  problems: method ? [] : [{ problem: 'choose_fulfillment', sellerProfileId: grace.id }],
  ...over,
});

const address = {
  id: ADDRESS,
  user_id: TEST_USER_ID,
  label: 'Home',
  recipient_name: 'Test User',
  phone: '876 555 0101',
  line1: '1 Hope Rd',
  line2: null,
  town: 'Kingston',
  parish: 'Kingston',
  instructions: null,
  is_default: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

const order = (status = 'paid'): Order =>
  ({
    id: ORDER,
    checkout_id: CHECKOUT,
    community_id: C,
    buyer_user_id: TEST_USER_ID,
    seller_user_id: OTHER_USER_ID,
    seller_profile_id: grace.id,
    seller_name: 'Grace Goods',
    status,
    fulfillment_method: 'pickup',
    address_snapshot: null,
    contact_snapshot: { name: 'Test User', phone: '876 555 0101' },
    currency: 'JMD',
    subtotal_minor: 4_500_000,
    delivery_minor: 0,
    tax_minor: 0,
    total_minor: 4_500_000,
    estimated_days_min: null,
    estimated_days_max: null,
    status_reason: null,
    accepted_at: null,
    completed_at: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
  }) as Order;
const item: OrderItem = {
  id: '0e000000-0000-4000-8000-000000000001',
  order_id: ORDER,
  listing_id: laptop.id,
  title_snapshot: 'Used laptop',
  image_path_snapshot: null,
  quantity: 1,
  unit_price_minor: 4_500_000,
  tax_minor: 0,
  line_total_minor: 4_500_000,
};

const payState = (over: Partial<CheckoutPaymentState> = {}): CheckoutPaymentState => ({
  checkoutStatus: 'awaiting_payment',
  totalMinor: 4_500_000,
  currency: 'JMD',
  reservationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  payment: null,
  paid: false,
  ...over,
});

describe('cart', () => {
  test('add from the listing page; the cart shows server prices and a subtotal', async () => {
    const { user } = await openMarket();
    await user.press(await screen.findByTestId(`listing-${laptop.id}`));
    await user.press(await screen.findByRole('button', { name: 'Add to cart' }));
    await user.press(await screen.findByRole('button', { name: 'Go to cart' }));
    await screen.findByTestId('cart-screen');
    expect(screen.getByTestId(`cart-line-${laptop.id}`)).toHaveTextContent(/Used laptop/);
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('J$45,000');
    await user.press(screen.getByRole('button', { name: 'More: Quantity of Used laptop' }));
    await waitFor(() => expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('J$90,000'));
  });
});

describe('checkout', () => {
  test('choose delivery and an address; the order is placed with the total the buyer saw', async () => {
    const { user, dependencies } = await openMarket();
    const s = dependencies.services;
    jest.spyOn(s.orders, 'addresses').mockResolvedValue([address]);
    const priced = jest
      .spyOn(s.orders, 'preview')
      .mockImplementation(async (_c, choices = []) => preview({}, choices[0]?.method ?? null));
    const create = jest.spyOn(s.orders, 'create').mockResolvedValue(CHECKOUT);
    jest.spyOn(s.payments, 'state').mockResolvedValue(payState());
    await s.cart.setQuantity(laptop.id, 1);
    await user.press(screen.getByTestId('market-cart'));
    await user.press(await screen.findByTestId('cart-checkout'));
    await screen.findByTestId('checkout-screen');
    expect(screen.getByTestId('checkout-problem-choose_fulfillment')).toBeTruthy();
    expect(screen.getByTestId('checkout-place')).toBeDisabled();

    await user.press(within(screen.getByTestId(`checkout-method-${grace.id}`)).getByText('Seller delivers'));
    await waitFor(() => expect(screen.getByTestId('checkout-total')).toHaveTextContent('J$45,500'));
    expect(priced).toHaveBeenLastCalledWith(
      C,
      [{ sellerProfileId: grace.id, method: 'seller_delivery' }],
      ADDRESS,
    );
    expect(screen.getByTestId('checkout-contact-phone').props.value).toBe('876 555 0101');
    await user.press(screen.getByTestId('checkout-place'));
    await screen.findByTestId('payment-screen');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: C,
        addressId: ADDRESS,
        expectedTotalMinor: 4_550_000,
        choices: [{ sellerProfileId: grace.id, method: 'seller_delivery' }],
      }),
    );
  });

  test('a total that changed on the server is explained and nothing is paid', async () => {
    const { user, dependencies } = await openMarket();
    const s = dependencies.services;
    const { ServiceError } =
      jest.requireActual<typeof import('@communione/services')>('@communione/services');
    jest.spyOn(s.orders, 'addresses').mockResolvedValue([]);
    jest.spyOn(s.orders, 'preview').mockResolvedValue(preview({}, 'pickup'));
    const create = jest
      .spyOn(s.orders, 'create')
      .mockRejectedValue(new ServiceError('VALIDATION', 'the total changed to 4600000; review your order'));
    await s.cart.setQuantity(laptop.id, 1);
    await user.press(screen.getByTestId('market-cart'));
    await user.press(await screen.findByTestId('cart-checkout'));
    await screen.findByTestId('checkout-screen');
    await user.type(screen.getByTestId('checkout-contact-name'), 'Test User');
    await user.type(screen.getByTestId('checkout-contact-phone'), '876 555 0101');
    await user.press(screen.getByTestId('checkout-place'));
    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(/total changed/i);
    expect(create.mock.calls[0]![0].addressId).toBeNull();
    expect(screen.queryByTestId('payment-screen')).toBeNull();
  });
});

describe('payment', () => {
  async function openPayment() {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest
      .spyOn(s.orders, 'myOrders')
      .mockResolvedValue({ items: [{ ...order('pending_payment'), items: [item] }], nextCursor: null });
    jest.spyOn(s.orders, 'order').mockResolvedValue({
      order: order('pending_payment'),
      items: [item],
      events: [],
      checkout: { id: CHECKOUT, status: 'awaiting_payment' } as OrderDetail['checkout'],
      role: 'buyer',
      shipment: null,
      pickupCode: null,
    });
    return app;
  }

  test('returning from the payment page is not payment: the screen waits for the server', async () => {
    const app = await openPayment();
    const s = app.dependencies.services;
    const state = jest
      .spyOn(s.payments, 'state')
      .mockResolvedValueOnce(payState())
      .mockResolvedValue(
        payState({
          paid: true,
          checkoutStatus: 'paid',
          payment: { id: 'p1', status: 'succeeded', mode: 'test', failureCode: null },
        }),
      );
    const start = jest.spyOn(s.payments, 'start').mockResolvedValue({
      paymentId: 'p1',
      redirectUrl: 'https://pay.example/x',
      expiresAt: null,
      mode: 'test',
    });
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(await screen.findByTestId(`order-row-${ORDER}`));
    await app.user.press(await screen.findByTestId('order-pay'));
    expect(await screen.findByTestId('payment-status')).toHaveTextContent('Payment needed');
    await app.user.press(screen.getByTestId('payment-pay'));
    expect(start).toHaveBeenCalledWith(CHECKOUT);
    expect(app.payment.browser.open).toHaveBeenCalledWith(
      'https://pay.example/x',
      'communione://payment-return',
    );
    expect(await screen.findByText('Payment confirmed')).toBeTruthy();
    expect(screen.getByTestId('payment-test-mode')).toHaveTextContent(/no real money/);
    expect(state.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('a declined payment is shown as not completed and can be tried again', async () => {
    const app = await openPayment();
    const s = app.dependencies.services;
    jest
      .spyOn(s.payments, 'state')
      .mockResolvedValueOnce(payState())
      .mockResolvedValue(
        payState({
          checkoutStatus: 'payment_failed',
          payment: { id: 'p1', status: 'failed', mode: 'test', failureCode: 'failed' },
        }),
      );
    jest.spyOn(s.payments, 'start').mockResolvedValue({
      paymentId: 'p1',
      redirectUrl: 'https://pay.example/x',
      expiresAt: null,
      mode: 'test',
    });
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(await screen.findByTestId(`order-row-${ORDER}`));
    await app.user.press(await screen.findByTestId('order-pay'));
    await app.user.press(await screen.findByTestId('payment-pay'));
    expect(await screen.findByTestId('payment-notice')).toHaveTextContent(/not completed/);
    expect(screen.queryByText('Payment confirmed')).toBeNull();
    expect(screen.getByTestId('payment-pay')).toBeTruthy();
  });
});

describe('orders', () => {
  test('the order page shows the server status, items and history', async () => {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest
      .spyOn(s.orders, 'myOrders')
      .mockResolvedValue({ items: [{ ...order('paid'), items: [item] }], nextCursor: null });
    jest.spyOn(s.orders, 'order').mockResolvedValue({
      order: order('paid'),
      items: [item],
      role: 'buyer',
      checkout: null,
      shipment: null,
      pickupCode: null,
      events: [
        {
          id: 'e1',
          order_id: ORDER,
          from_status: 'pending_payment',
          to_status: 'paid',
          actor_user_id: null,
          reason: null,
          created_at: '2026-10-14T10:01:00Z',
        },
      ],
    });
    await app.user.press(screen.getByTestId('market-orders'));
    expect(await screen.findByTestId(`order-status-${ORDER}`)).toHaveTextContent(
      'Paid, waiting for the seller',
    );
    await app.user.press(screen.getByTestId(`order-row-${ORDER}`));
    expect(await screen.findByTestId('order-detail-status')).toHaveTextContent(
      'Paid, waiting for the seller',
    );
    expect(screen.getByTestId('order-total')).toHaveTextContent('J$45,000');
    expect(screen.getByTestId('order-history')).toHaveTextContent(/Paid/);
    expect(screen.queryByTestId('order-pay')).toBeNull();
    expect(screen.queryByTestId('order-contact')).toBeNull();
  });

  test('rules in words', () => {
    expect(orderStatusLabel('ready_for_pickup')).toBe('Ready for pickup');
    expect(problemText('delivery_not_available')).toMatch(/does not deliver/);
    expect(estimateText({ min: 1, max: 2 })).toBe('1-2 days');
    expect(estimateText({ min: null, max: 1 })).toBe('1 day');
    expect(estimateText(null)).toBeNull();
  });
});

describe('fulfillment', () => {
  const detail = (
    status: string,
    role: 'buyer' | 'seller',
    over: Partial<OrderDetail> = {},
  ): OrderDetail => ({
    order: { ...order(status), fulfillment_method: 'pickup' },
    items: [item],
    events: [],
    checkout: null,
    role,
    shipment: null,
    pickupCode: null,
    ...over,
  });

  async function openSale(d: OrderDetail) {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest.spyOn(s.orders, 'myOrders').mockResolvedValue({ items: [], nextCursor: null });
    jest
      .spyOn(s.orders, 'sellerOrders')
      .mockResolvedValue({ items: [{ ...d.order, items: [item] }], nextCursor: null });
    const load = jest.spyOn(s.orders, 'order').mockResolvedValue(d);
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(within(await screen.findByTestId('orders-side')).getByText('Sales'));
    await app.user.press(await screen.findByTestId(`order-row-${ORDER}`));
    await screen.findByTestId('order-detail');
    return { ...app, s, load };
  }

  test('the seller accepts a paid order, or declines it with a reason', async () => {
    const { user, s, load } = await openSale(detail('paid', 'seller'));
    expect(screen.getByTestId('order-contact')).toHaveTextContent(/876 555 0101/);
    const accept = jest.spyOn(s.orders, 'accept').mockResolvedValue();
    await user.press(screen.getByTestId('order-accept'));
    expect(accept).toHaveBeenCalledWith(ORDER);
    load.mockResolvedValue(detail('paid', 'seller'));
    const reject = jest.spyOn(s.orders, 'reject').mockResolvedValue();
    await user.press(await screen.findByTestId('order-reject'));
    await user.type(screen.getByTestId('order-form-text'), 'Sold out');
    await user.press(screen.getByTestId('order-form-submit'));
    expect(reject).toHaveBeenCalledWith(ORDER, 'Sold out');
  });

  test('pickup handover: a wrong code is refused; the right one completes the order', async () => {
    const { user, s } = await openSale(detail('ready_for_pickup', 'seller'));
    const confirm = jest
      .spyOn(s.orders, 'confirmPickup')
      .mockResolvedValueOnce('wrong_code')
      .mockResolvedValueOnce('completed');
    await user.press(screen.getByTestId('order-pickup'));
    await user.type(screen.getByTestId('order-form-text'), '111111');
    await user.press(screen.getByTestId('order-form-submit'));
    expect(await screen.findByTestId('order-action-error')).toHaveTextContent(/not right/);
    await user.clear(screen.getByTestId('order-form-text'));
    await user.type(screen.getByTestId('order-form-text'), '123456');
    await user.press(screen.getByTestId('order-form-submit'));
    expect(await screen.findByTestId('order-action-notice')).toHaveTextContent(/complete/);
    expect(confirm).toHaveBeenLastCalledWith(ORDER, '123456');
  });

  test('the buyer sees the pickup code and what the seller recorded about a delivery', async () => {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest
      .spyOn(s.orders, 'myOrders')
      .mockResolvedValue({ items: [{ ...order('ready_for_pickup'), items: [item] }], nextCursor: null });
    const load = jest
      .spyOn(s.orders, 'order')
      .mockResolvedValue(detail('ready_for_pickup', 'buyer', { pickupCode: '482913' }));
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(await screen.findByTestId(`order-row-${ORDER}`));
    expect(await screen.findByTestId('order-pickup-code')).toHaveTextContent(/482913/);
    expect(screen.queryByTestId('order-contact')).toBeNull();
    expect(load).toHaveBeenCalledWith(ORDER);
  });

  test('dispatch sends only the courier details the seller typed', async () => {
    const d = detail('accepted', 'seller');
    d.order = { ...d.order, fulfillment_method: 'seller_delivery' };
    const { user, s } = await openSale(d);
    const dispatch = jest.spyOn(s.orders, 'dispatch').mockResolvedValue();
    await user.press(screen.getByTestId('order-dispatch'));
    await user.type(screen.getByTestId('order-form-courier'), 'Knutsford Express');
    await user.type(screen.getByTestId('order-form-tracking'), 'KX1');
    await user.press(screen.getByTestId('order-form-submit'));
    expect(dispatch).toHaveBeenCalledWith(ORDER, {
      courierName: 'Knutsford Express',
      trackingReference: 'KX1',
      trackingUrl: null,
    });
  });
});

describe('refunds and disputes', () => {
  const refund = (over: Partial<Refund> = {}): Refund =>
    ({
      id: 'rf000000-0000-4000-8000-000000000001'.replace('rf', 'af'),
      community_id: C,
      payment_id: 'p1',
      order_id: ORDER,
      booking_id: null,
      buyer_user_id: TEST_USER_ID,
      seller_user_id: OTHER_USER_ID,
      kind: 'customer',
      requested_by: TEST_USER_ID,
      reason: 'One fan arrived broken',
      amount_minor: 400_000,
      currency: 'JMD',
      status: 'requested',
      decision_note: null,
      decided_by: null,
      provider_refund_reference: null,
      failure_code: null,
      attempts: 0,
      created_at: '2026-10-14T10:00:00Z',
      updated_at: '2026-10-14T10:00:00Z',
      succeeded_at: null,
      ...over,
    }) as Refund;

  async function openOrder(
    role: 'buyer' | 'seller',
    status: string,
    refunds: Refund[] = [],
    communities?: unknown[],
  ) {
    const app = await openMarket(communities);
    const s = app.dependencies.services;
    const d: OrderDetail = {
      order: order(status),
      items: [item],
      events: [],
      checkout: null,
      role,
      shipment: null,
      pickupCode: null,
    };
    jest
      .spyOn(s.orders, 'myOrders')
      .mockResolvedValue({ items: [{ ...d.order, items: [item] }], nextCursor: null });
    jest
      .spyOn(s.orders, 'sellerOrders')
      .mockResolvedValue({ items: [{ ...d.order, items: [item] }], nextCursor: null });
    jest.spyOn(s.orders, 'order').mockResolvedValue(d);
    jest.spyOn(s.refunds, 'forOrder').mockResolvedValue(refunds);
    jest.spyOn(s.refunds, 'disputesForOrder').mockResolvedValue([]);
    await app.user.press(screen.getByTestId('market-orders'));
    if (role === 'seller')
      await app.user.press(within(await screen.findByTestId('orders-side')).getByText('Sales'));
    await app.user.press(await screen.findByTestId(`order-row-${ORDER}`));
    await screen.findByTestId('order-detail');
    return { ...app, s };
  }

  test('the buyer asks for part of the money back, seeing the community policy as written', async () => {
    const { user, s } = await openOrder('buyer', 'completed');
    jest.spyOn(s.refunds, 'policy').mockResolvedValue({
      community_id: C,
      requests_enabled: true,
      request_window_days: 14,
      policy_text: 'Unused items within 7 days.',
      updated_by: null,
      updated_at: '',
    });
    const request = jest.spyOn(s.refunds, 'request').mockResolvedValue('r1');
    await user.press(screen.getByTestId('order-refund'));
    expect(await screen.findByTestId('refund-policy')).toHaveTextContent(/Unused items within 7 days\./);
    await user.press(within(screen.getByTestId('refund-scope')).getByText('Part of it'));
    await user.type(screen.getByTestId('refund-amount'), '1500');
    await user.type(screen.getByTestId('refund-reason'), 'One fan arrived broken');
    await user.press(screen.getByTestId('refund-submit'));
    expect(request).toHaveBeenCalledWith(ORDER, 'One fan arrived broken', 150_000);
  });

  test('an approved refund is not shown as refunded; only a provider-confirmed one is', async () => {
    await openOrder('buyer', 'accepted', [
      refund({ id: 'a1', status: 'approved' }),
      refund({ id: 'a2', status: 'succeeded', amount_minor: 100_000 }),
    ]);
    expect(await screen.findByTestId('refund-status-a1')).toHaveTextContent('Approved, waiting to be sent');
    expect(screen.getByTestId('refund-status-a2')).toHaveTextContent('Refunded');
  });

  test('the seller approves a smaller amount', async () => {
    const { user, s } = await openOrder('seller', 'accepted', [refund({ id: 'a3' })]);
    const decide = jest.spyOn(s.refunds, 'decide').mockResolvedValue();
    await user.press(await screen.findByTestId('refund-review-a3'));
    await user.type(screen.getByTestId('refund-decide-amount'), '2000');
    await user.type(screen.getByTestId('refund-decide-note'), 'Partial');
    await user.press(screen.getByTestId('refund-approve'));
    expect(decide).toHaveBeenCalledWith('a3', true, { amountMinor: 200_000, note: 'Partial' });
  });

  test('a declined refund can go to the community; a manager who is not a party decides', async () => {
    const maple = sampleCommunities[0]!;
    const { user, s } = await openOrder(
      'buyer',
      'accepted',
      [refund({ id: 'a4', status: 'rejected', decision_note: 'Works fine' })],
      [maple],
    );
    const open = jest.spyOn(s.refunds, 'openDispute').mockResolvedValue('d1');
    const dispute = {
      id: 'd1',
      community_id: maple.community_id,
      order_id: ORDER,
      booking_id: null,
      buyer_user_id: OTHER_USER_ID,
      seller_user_id: '00000000-0000-4000-8000-0000000000ff',
      reason: 'It flickers',
      status: 'open',
      resolution_note: null,
      resolved_by: null,
      refund_id: null,
      created_at: '2026-10-14T10:00:00Z',
      updated_at: '2026-10-14T10:00:00Z',
      resolved_at: null,
    };
    jest.spyOn(s.refunds, 'dispute').mockResolvedValue({ dispute, messages: [] });
    const resolve = jest.spyOn(s.refunds, 'resolve').mockResolvedValue();
    await user.press(await screen.findByTestId('order-new-dispute'));
    await user.type(await screen.findByTestId('dispute-reason'), 'The lamp flickers all the time');
    await user.press(screen.getByTestId('dispute-submit'));
    expect(open).toHaveBeenCalledWith(ORDER, 'The lamp flickers all the time');
    // The viewer here is not a party and holds marketplace.manage (Owner of Maple).
    await screen.findByTestId('dispute-decide');
    await user.type(screen.getByTestId('dispute-amount'), '500');
    await user.type(screen.getByTestId('dispute-note'), 'Half for the flicker');
    await user.press(screen.getByTestId('dispute-resolve'));
    expect(resolve).toHaveBeenCalledWith('d1', {
      refund: true,
      amountMinor: 50_000,
      note: 'Half for the flicker',
    });
  });
});

describe('bookings', () => {
  const BOOKING = '0b000000-0000-4000-8000-000000000001';
  const booking = (status: string, over: Partial<Booking> = {}): Booking =>
    ({
      id: BOOKING,
      community_id: C,
      listing_id: tutoring.id,
      seller_profile_id: grace.id,
      seller_user_id: OTHER_USER_ID,
      buyer_user_id: TEST_USER_ID,
      title_snapshot: 'Maths tutoring',
      pricing_snapshot: 'hourly',
      unit_price_minor: 300_000,
      status,
      amount_minor: status === 'requested' ? null : 600_000,
      currency: 'JMD',
      buyer_note: null,
      location_note: null,
      status_reason: null,
      payment_due_at: '2030-01-01T00:00:00Z',
      created_at: '2026-10-14T10:00:00Z',
      updated_at: '2026-10-14T10:00:00Z',
      startsAt: '2030-01-02T15:00:00.000Z',
      endsAt: '2030-01-02T17:00:00.000Z',
      ...over,
    }) as Booking;

  test('times: inside the seller hours, whole hours, never over busy periods', () => {
    const [day] = nextDates(1, Date.parse('2026-10-14T12:00:00Z'));
    expect(day).toBe('2026-10-15');
    expect(localToIso('2026-10-15', '10:00')).toBe('2026-10-15T15:00:00.000Z');
    const windows = [{ weekday: 4, start: '09:00', end: '13:00' }]; // Thursday
    expect(startTimes('2026-10-15', 2, windows, [])).toEqual(['09:00', '10:00', '11:00']);
    const busy = [{ startsAt: localToIso('2026-10-15', '10:00'), endsAt: localToIso('2026-10-15', '11:00') }];
    expect(startTimes('2026-10-15', 1, windows, busy)).toEqual(['09:00', '11:00', '12:00']);
    expect(startTimes('2026-10-16', 1, windows, [])).toEqual([]);
  });

  test('the buyer requests a time; only the chosen slot is sent', async () => {
    const { user, dependencies } = await openMarket();
    const s = dependencies.services;
    jest.spyOn(s.bookings, 'availability').mockResolvedValue([]);
    jest.spyOn(s.bookings, 'busy').mockResolvedValue([]);
    const request = jest.spyOn(s.bookings, 'request').mockResolvedValue(BOOKING);
    jest
      .spyOn(s.bookings, 'booking')
      .mockResolvedValue({ booking: booking('requested'), events: [], role: 'buyer' });
    await user.press(await screen.findByTestId(`listing-${tutoring.id}`));
    await user.press(await screen.findByTestId('listing-book'));
    await screen.findByTestId('book-service');
    expect(screen.getByTestId('book-submit')).toBeDisabled();
    await user.press(within(screen.getByTestId('slot-hours')).getByText('2 hours'));
    await user.press(within(screen.getByTestId('slot-start')).getByText('10:00'));
    await user.type(screen.getByTestId('book-note'), 'Grade 9');
    await user.press(screen.getByTestId('book-submit'));
    const sent = request.mock.calls[0]![0];
    expect(sent.listingId).toBe(tutoring.id);
    expect(Date.parse(sent.endsAt) - Date.parse(sent.startsAt)).toBe(2 * 3_600_000);
    expect(sent.startsAt).toMatch(/T15:00:00.000Z$/);
    expect(await screen.findByTestId('booking-status')).toHaveTextContent('Waiting for the seller');
  });

  test('an accepted booking is paid through the payment screen; confirmed only by the server', async () => {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest.spyOn(s.bookings, 'list').mockResolvedValue({ items: [booking('accepted')], nextCursor: null });
    jest
      .spyOn(s.bookings, 'booking')
      .mockResolvedValue({ booking: booking('accepted'), events: [], role: 'buyer' });
    const pending = {
      status: 'accepted',
      amountMinor: 600_000,
      currency: 'JMD',
      paymentDueAt: '2030-01-01T00:00:00Z',
      payment: null,
      paid: false,
    };
    jest
      .spyOn(s.payments, 'bookingState')
      .mockResolvedValueOnce(pending)
      .mockResolvedValue({
        ...pending,
        status: 'confirmed',
        paid: true,
        payment: { id: 'p', status: 'succeeded', mode: 'test', failureCode: null },
      });
    const start = jest.spyOn(s.payments, 'startBooking').mockResolvedValue({
      paymentId: 'p',
      redirectUrl: 'https://pay.example/b',
      expiresAt: null,
      mode: 'test',
    });
    jest.spyOn(s.orders, 'myOrders').mockResolvedValue({ items: [], nextCursor: null });
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(await screen.findByTestId('orders-bookings'));
    await app.user.press(await screen.findByTestId(`booking-row-${BOOKING}`));
    await app.user.press(await screen.findByTestId('booking-pay'));
    await app.user.press(await screen.findByTestId('payment-pay'));
    expect(start).toHaveBeenCalledWith(BOOKING);
    expect(await screen.findByText('Payment confirmed')).toBeTruthy();
  });

  test('the seller sets the price of a quoted service when accepting', async () => {
    const app = await openMarket();
    const s = app.dependencies.services;
    jest
      .spyOn(s.bookings, 'list')
      .mockResolvedValue({ items: [booking('requested', { pricing_snapshot: 'quote' })], nextCursor: null });
    jest.spyOn(s.bookings, 'booking').mockResolvedValue({
      booking: booking('requested', { pricing_snapshot: 'quote' }),
      events: [],
      role: 'seller',
    });
    const accept = jest.spyOn(s.bookings, 'accept').mockResolvedValue();
    jest.spyOn(s.orders, 'myOrders').mockResolvedValue({ items: [], nextCursor: null });
    await app.user.press(screen.getByTestId('market-orders'));
    await app.user.press(await screen.findByTestId('orders-bookings'));
    await app.user.press(within(await screen.findByTestId('bookings-side')).getByText('For my services'));
    await app.user.press(await screen.findByTestId(`booking-row-${BOOKING}`));
    await app.user.press(await screen.findByTestId('booking-accept'));
    await app.user.type(screen.getByTestId('booking-form-text'), '9000');
    await app.user.press(screen.getByTestId('booking-form-submit'));
    expect(accept).toHaveBeenCalledWith(BOOKING, 900_000);
  });
});

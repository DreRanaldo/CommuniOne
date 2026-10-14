// Service bookings (Stage J, migration 38) end to end: weekly hours,
// requests, server-fixed prices, no double booking (also under concurrent
// acceptance), proposals, payment through the TEST provider, cancellation
// with a full refund, and privacy.
//
//   A: owner (Owner), seller, buyer, buyer2 (Members)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';
import { ledgerSum, paymentHarness } from './paymentHarness.ts';

let u: Record<'owner' | 'seller' | 'buyer' | 'buyer2', TestUser>;
const c: Record<string, string> = {};
const id: Record<string, string> = {};
const h = paymentHarness();

// Jamaica is UTC-5 all year: 10:00 local = 15:00 UTC.
const day = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + n));
const at = (dayOffset: number, utcHour: number) => new Date(day(dayOffset).getTime() + utcHour * 3_600_000).toISOString();

before(async () => {
  u = await users('owner', 'seller', 'buyer', 'buyer2');
  c.A = await community(u.owner, 'BookingsA');
  for (const x of [u.seller, u.buyer, u.buyer2]) await addMember(c.A!, x.id, 'Member');
  const cats = await u.seller.services.marketplace.categories('service');
  const shop = await u.seller.services.marketplace.saveSellerProfile(c.A!, { displayName: 'Clean Co' });
  id.shop = shop.id;
  const hourly = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'service', categoryId: cats[0]!.id, title: 'House cleaning', pricing: 'hourly', priceMinor: 250_000, publish: true });
  id.hourly = hourly.id;
  const quote = await u.seller.services.marketplace.createListing({ communityId: c.A!, kind: 'service', categoryId: cats[0]!.id, title: 'Deep clean', pricing: 'quote', publish: true });
  id.quote = quote.id;
  // Every day, 08:00-18:00 local.
  await u.seller.services.bookings.saveAvailability(shop.id, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '08:00', end: '18:00' })));
});
after(() => cleanupCommunityContent(Object.values(c)));

test('requests must fit the seller’s hours; the price is fixed by the server on acceptance', async () => {
  const b = u.buyer.services.bookings;
  await rejects(b.request({ listingId: id.hourly!, startsAt: at(3, 7), endsAt: at(3, 8) }), ErrorCode.Validation);
  await rejects(u.seller.services.bookings.request({ listingId: id.hourly!, startsAt: at(3, 15), endsAt: at(3, 17) }), ErrorCode.Validation);
  await rejects(b.request({ listingId: id.hourly!, startsAt: at(3, 15), endsAt: at(3, 15) }), ErrorCode.Validation);
  id.first = await b.request({ listingId: id.hourly!, startsAt: at(3, 15), endsAt: at(3, 17), note: 'Two bedrooms' });
  assert.equal((await b.booking(id.first)).booking.status, 'requested');
  await rejects(b.accept(id.first), ErrorCode.NotFound);
  await u.seller.services.bookings.accept(id.first, 1); // a price is ignored for hourly services
  const { booking } = await b.booking(id.first);
  assert.equal(booking.status, 'accepted');
  assert.equal(Number(booking.amount_minor), 500_000, '2 hours x J$2,500');
  assert.equal(booking.startsAt, at(3, 15));
  await rejects(u.buyer2.services.bookings.request({ listingId: id.hourly!, startsAt: at(3, 16), endsAt: at(3, 18) }), ErrorCode.Validation);
  assert.equal((await u.buyer2.services.bookings.busy(id.shop!, at(3, 0), at(4, 0))).length, 1, 'busy times are visible, without details');
});

test('two overlapping requests: accepting both at once books exactly one', async () => {
  const one = await u.buyer.services.bookings.request({ listingId: id.hourly!, startsAt: at(4, 15), endsAt: at(4, 16) });
  const two = await u.buyer2.services.bookings.request({ listingId: id.hourly!, startsAt: at(4, 15), endsAt: at(4, 17) });
  const results = await Promise.allSettled([u.seller.services.bookings.accept(one), u.seller.services.bookings.accept(two)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const { data } = await admin.from('bookings').select('status').in('id', [one, two]);
  assert.deepEqual(data!.map((r) => r.status).sort(), ['accepted', 'requested']);
});

test('a quote-priced service: the seller proposes a time, the buyer agrees, the seller sets the price', async () => {
  const bid = await u.buyer.services.bookings.request({ listingId: id.quote!, startsAt: at(5, 15), endsAt: at(5, 18) });
  await u.seller.services.bookings.propose(bid, at(5, 13), at(5, 16), 'Earlier works better');
  assert.equal((await u.buyer.services.bookings.booking(bid)).booking.status, 'proposed');
  await u.buyer.services.bookings.acceptProposal(bid);
  await rejects(u.seller.services.bookings.accept(bid), ErrorCode.Validation);
  await u.seller.services.bookings.accept(bid, 900_000);
  const { booking, events } = await u.buyer.services.bookings.booking(bid);
  assert.equal(Number(booking.amount_minor), 900_000);
  assert.equal(booking.startsAt, at(5, 13));
  assert.deepEqual(events.map((e) => e.to_status), ['requested', 'proposed', 'requested', 'accepted']);
});

test('paying confirms the booking; a seller cancellation refunds in full', async () => {
  assert.equal((await h.sessionBooking(u.buyer2, id.first!)).status, 404, "someone else's booking");
  const s = await h.sessionBooking(u.buyer, id.first!);
  assert.equal(s.status, 200);
  await h.pay(s.body.redirectUrl!, 'succeeded');
  const state = await u.buyer.services.payments.bookingState(id.first!);
  assert.equal(state.paid, true);
  assert.equal(state.status, 'confirmed');
  assert.equal(await ledgerSum(c.A!), 0);
  await rejects(u.buyer2.services.bookings.cancel(id.first!, 'not mine'), ErrorCode.NotFound);
  await u.seller.services.bookings.cancel(id.first!, 'Sick on that day');
  const { data: refunds } = await u.buyer.client.from('refunds').select('status, amount_minor, booking_id').eq('booking_id', id.first!);
  assert.deepEqual(refunds, [{ status: 'approved', amount_minor: 500_000, booking_id: id.first }]);
  await h.refunds();
  const { data: done } = await u.buyer.client.from('refunds').select('status').eq('booking_id', id.first!).single();
  assert.equal(done!.status, 'succeeded');
  assert.equal(await ledgerSum(c.A!), 0);
});

test('bookings are private to their buyer and seller', async () => {
  const mine = await u.buyer.services.bookings.list({ communityId: c.A!, as: 'buyer' });
  assert.ok(mine.items.length >= 2);
  const theirs = await u.seller.services.bookings.list({ communityId: c.A!, as: 'seller' });
  assert.ok(theirs.items.length >= 4);
  await rejects(u.owner.services.bookings.booking(id.first!), ErrorCode.NotFound);
  const { data } = await u.owner.client.from('bookings').select('id');
  assert.deepEqual(data, []);
});

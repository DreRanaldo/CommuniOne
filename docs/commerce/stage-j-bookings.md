# Stage J: service bookings

**Status:** implemented and tested. Payment uses the same **test-mode**
payment flow as products.

## Lifecycle (migration 38)

```
requested ──seller accepts (price fixed by the server)──> accepted ──paid──> confirmed ──seller──> completed
requested ──seller proposes another time──> proposed ──buyer agrees──> requested
requested | proposed ──seller declines──> declined
requested | proposed | accepted | confirmed ──either side cancels──> cancelled
accepted, not paid in 24 h (or by the start) ──job──> expired
requested | proposed whose start has passed ──job──> expired
confirmed, 3 days after the end ──job──> completed
```

* **No double booking.** An exclusion constraint
  (`btree_gist`: seller × time range) holds for accepted and confirmed
  bookings, even for trusted code. When two overlapping requests are
  accepted at once, exactly one succeeds; a real-database race test covers
  this.
* **Hours.** A seller sets weekly hours in Jamaica time
  (`service_availability_save`) and time off. With no hours set, any time
  can be requested. Requests must:
  * start at least 1 hour and at most 180 days ahead;
  * last 15 minutes to 12 hours;
  * fall inside the seller's hours and outside their time off.
* **Price.** It is fixed by the server when the seller accepts:
  * fixed price;
  * hourly price × duration;
  * or, for quote-priced services, the seller's price.
  The buyer pays exactly that amount (`payment_begin_booking`).
* **Busy times.** `seller_busy_times` shows buyers only the start and end
  of busy periods, never who booked.
* **Cancelling.** Cancelling a confirmed booking creates a **full** refund
  record. Cancellation fees are not implemented (decision D6). Refunds are
  completed by `refunds-process` like order refunds, and come out of the
  seller's balance.
* **Paying twice, or after the booking closed.** The payment is refunded
  automatically.
* **Disputes.** Paid bookings can be disputed (`booking_dispute_open`) and
  are decided by the same community managers as order disputes.

## App

* The listing page shows "Request a booking" (services).
* The booking screen offers a day (next 14 days), a length (1–4 h) and free
  start times computed from the seller's hours and busy periods. The
  server checks every time again.
* Orders → Service bookings lists "Booked by me" and, for sellers, "For my
  services".
* The booking page shows the steps allowed for its status: accept (with a
  price for quoted services), propose another time, decline, pay, agree,
  cancel, mark done, report a problem.
* Shop → Hours sets the weekly booking hours.

## Not done

* Recurring bookings, deposits, cancellation fees, and seller calendars
  with time-off editing in the app (time off is in the API only).
* Reminders before a booking (Stage L notifications cover state changes
  only).

## Tests

| Layer | File | Count |
|---|---|---|
| pgTAP | `038_marketplace_bookings` | 30 |
| Node + real local stack | `tests/services/bookings.test.ts` | 5 |
| App | `commerce.test.tsx` (bookings) | 4 |

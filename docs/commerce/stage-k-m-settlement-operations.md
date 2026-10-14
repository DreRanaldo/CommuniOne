# Stages K–M: balances, notifications, operations, security review

## K — Seller balances and payout records (migration 39)

* `seller_balance(community)` and `seller_statement(community)` read the
  caller's own seller account in the ledger. They return earned, refunded,
  paid out and balance figures, and statement lines.
* **There are no automatic payouts.** No provider payout or split-payment
  feature is connected or verified (D2, D7). CommuniOne does not hold
  funds in escrow and does not claim to.
* `payout_record(...)` is **service role only**: an operator, never a
  community admin. It records money already sent to a seller outside the
  app, for example a bank transfer, with its external reference. It:
  * refuses more than the seller's balance (under an advisory lock);
  * posts the ledger (`seller_payable +`, `platform_clearing −`);
  * is audited, and notifies the seller without any bank details.
* `ledger_summary(community)` (service role) returns per-account balances
  for reconciliation. They always sum to zero.
* Not implemented, pending owner decisions:
  * commission (D4);
  * processing-fee allocation (D5);
  * hold periods and negative-balance handling (D7);
  * payout schedules;
  * tax reporting.

App: Shop → Earnings shows the balance, statement and payouts, with a
notice that payouts are not automatic.

## L — Notifications, audit, support

**Notifications.** The types are `order`, `payment`, `refund`, `delivery`,
`booking` and `dispute`.

* They are transactional, like personal event changes: always delivered,
  not switchable per community.
* They carry ids only. They never include card data, amounts, provider
  references or addresses.
* Each one is de-duplicated by key.
* The notification center opens the order, payment, booking, dispute or
  earnings screen. That screen re-reads the item under RLS.

**Audit actions** (all through `private.record_audit_event`):

* `payment.succeeded`, `payment.failed`, `payment.mismatch`;
* `order.cancelled`;
* `refund.succeeded`, `refund.failed`, `refund_policy.updated`;
* `dispute.opened`, `dispute.resolved`;
* `booking.cancelled`;
* `payout.recorded`;
* plus the Stage B catalog actions.

**Support tools:**

* Community managers (`marketplace.manage`) have:
  * Admin → Marketplace disputes (decide disputes; refunds capped);
  * Admin → Refund settings (window and the community's own policy text).
* Operators (service role) have:
  * `refund_retry` for failed refunds;
  * `payout_record`;
  * `ledger_summary`;
  * the audit log.

## M — End-to-end, recovery and security review

### Recovery drills (automated)

| Failure | Behaviour | Test |
|---|---|---|
| Webhook lost | `payments-reconcile` asks the provider and applies the result | `payments.test.ts` |
| Webhook replayed or duplicated | `duplicate`; nothing changes | `payments.test.ts`, pgTAP 035 |
| Forged, stale or unsigned webhook | 401; nothing stored | `payments.test.ts` |
| Amount mismatch | Held as `unknown` / `amount_mismatch`, audited, never settled | pgTAP 035 |
| Payment after the reservation ended and stock is gone | Orders cancelled, full automatic refund | `payments.test.ts` |
| Paid twice | Second payment flagged, booked to platform revenue, refunded | pgTAP 035 |
| Provider unavailable during a refund | Back to `approved`; retried by the next run | `handleRefunds` |
| Provider refuses a refund | `failed`, audited, operator retry | `refunds.test.ts` |
| Seller never accepts | Refunded after 48 h | pgTAP 036 |
| Many buyers, few units, concurrent payments | No overselling; stock, orders and ledger consistent | `scripts/db/checkout-stress.sh` (CI) |
| Concurrent booking acceptance | Exclusion constraint: exactly one | `bookings.test.ts`, pgTAP 038 |

### Security review

The automated sweep is `supabase/tests/database/039_marketplace_security`.
It covers every commerce table and function:

* **RLS** is on everywhere.
* **anon** and PUBLIC have no table privileges and cannot call commerce
  functions.
* **Clients write only** catalog rows, favorites, delivery options and
  their own address book. Orders, payments, refunds, the ledger,
  bookings and disputes change only through checked functions.
* **Payment events, webhooks, the ledger and test-provider state** are
  unreadable by clients, and so are provider references and session links.
* **Service-only functions** cannot be called by clients:
  * payment begin/apply and reconcile;
  * refund claim/apply/retry;
  * payouts and the ledger summary;
  * jobs.
* **Private money helpers** cannot be called by clients.
* **Every security definer function** pins its `search_path`.
* **Financial and history tables** are append-only.
* **Money invariants:**
  * balanced-ledger trigger;
  * one success per checkout or booking;
  * one row per provider event;
  * no double booking.

Mutation-checked: granting a service-only function, an UPDATE on orders, or
disabling RLS on payouts each fails the sweep.

Further review findings fixed during these stages:

* A second success for a paid checkout crashed on the unique index (money
  captured, never refunded). It is now flagged in the same statement.
* Sellers could read an unpaid order's contact and address. They now see
  orders only once paid.
* Ledger owner foreign keys would have blocked account deletion. Owners
  are now pseudonymous, like audit logs.
* Seller balances were global across communities. They are now per
  community (D1).
* Validation errors in some services were thrown synchronously. They are
  now rejected promises.

Residual risks (documented, not fixed):

* The test checkout page is reachable by anyone holding a signed link,
  which is harmless in test mode. It is disabled unless
  `PAYMENTS_MODE=test`.
* `payments-reconcile` and `refunds-process` must be scheduled. No
  schedule is deployed.
* No real provider's webhook format has been verified. The adapter
  interface is ready.
* There is no fraud screening, velocity check beyond rate limits, or
  chargeback handling (needs a real provider).
* Booking disputes do not notify community managers (order disputes do).
  Managers see them in the disputes list.

## Tests added in K–M

| Layer | File | Count |
|---|---|---|
| pgTAP | `039_marketplace_security` | 18 |
| Node + real local stack | `tests/services/earnings.test.ts` | 2 |
| Concurrency | `scripts/db/checkout-stress.sh` (CI, plain PostgreSQL) | 6 invariants |
| App | `commerce.test.tsx` (earnings), `notificationRules.test.ts` (marketplace routing) | 1 + 2 |

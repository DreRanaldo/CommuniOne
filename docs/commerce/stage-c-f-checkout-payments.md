# Stages C–F: cart, checkout, payments, ledger

**Status:** implemented and tested with the **TEST payment provider only**.
No real or sandbox provider is connected. No real money moves. Live
payments are **not operational** (decisions D2, D3 and merchant approval
are pending).

## What was built

| Stage | Database (migration) | Services | App |
|---|---|---|---|
| C — cart | 33 `marketplace_cart`: `carts`, `cart_items`, `cart_set_item`, `cart_clear`, `cart_quote` | `services.cart` | Cart screen; Add to cart on listings; cart badge on Market |
| D — checkout & orders | 34 `marketplace_checkout_orders`: `addresses`, `delivery_options`, `tax_rates`, `checkouts`, `orders`, `order_items`, `order_events`, `inventory_reservations`; `checkout_preview`, `checkout_create`, `checkout_cancel`, `expire_checkouts` | `services.orders` | Checkout, address editor, orders list/detail, seller delivery settings, Sales entry in the shop |
| E — payments | 35 `marketplace_payments_ledger`: `payments`, `payment_events`, `webhook_events`, `test_provider_sessions`; `payment_begin`, `payment_attach_session`, `payment_apply_event`, `payments_to_reconcile` | `services.payments`; Edge Functions `payments-session`, `payments-webhook`, `payments-reconcile`, `payments-test-checkout` | Payment screen (in-app browser, server status polling, test-mode banner) |
| F — state machine, refunds records, ledger | 35: `refunds`, `refund_items`, `refund_events`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`; settlement in `settle_paid_checkout` | — | — |

## How money is decided

* Prices, fees, tax and totals are computed **only** in Postgres
  (`private.price_checkout`). The app sends listing ids, quantities,
  pickup/delivery choices and an address id.
* `checkout_create` re-prices under row locks and refuses the order if the
  total differs from the one the buyer saw (`expected_total_minor`).
* It is idempotent per `(buyer, client_request_id)`: a retried tap returns
  the same checkout.
* Stock is reserved for 20 minutes (`inventory_reservations`). Rows are
  locked in listing-id order, so concurrent buyers cannot oversell; a real
  database race test proves exactly one of two buyers gets the last item.
* `expire_checkouts()` releases unpaid reservations. It runs from the
  reconcile function.
* Tax: GCT at `tax_rates.GCT_STANDARD` (15%) only for sellers marked
  `gct_registered`. **D9 must be confirmed by the owner and an accountant.**
  The app has no switch for it yet; an operator sets it.

## Payment flow (test provider)

1. The app calls `payments-session` with `{checkoutId}` and the user's JWT.
   The function resolves the user from the token, and `payment_begin`
   (service role) checks the buyer, the status and the reservation, then
   takes the amount from the checkout.
2. The provider session is created (idempotent per payment id) and the app
   opens its hosted page in an in-app browser. No card data touches the app
   or the database. The test page asks for none: it offers "Simulate
   successful payment", "Simulate declined payment" and "Cancel".
3. The provider's **signed webhook** reaches `payments-webhook`:
   * the signature is HMAC-SHA256 over `t.body` and must be at most 5
     minutes old; it is compared in constant time;
   * a rejected request stores nothing and returns 401;
   * `payment_apply_event` records each provider event id once, so
     duplicates return `duplicate`;
   * a wrong amount or currency becomes `unknown` / `amount_mismatch`, is
     audited and held for review;
   * a success settles the checkout atomically: stock committed, orders
     `paid`, ledger posted, sellers and buyer notified.
4. The app shows "Payment confirmed" **only** when the server says the
   checkout is paid. Returning from the page proves nothing on its own.
5. `payments-reconcile` (scheduled, service-role bearer) asks the provider
   about payments still open after 5 minutes and expires stale checkouts.
   This recovers lost webhooks.

Edge cases handled and tested:

| Case | Behaviour |
|---|---|
| Declined | Checkout becomes `payment_failed`; stock stays reserved; a retry creates a new attempt |
| Duplicate webhook | Returns `duplicate`; nothing changes |
| Late failure after success | Ignored |
| Second success for a paid checkout | Flagged `duplicate_payment`, booked to platform revenue, full automatic refund created |
| Payment after the reservation ended and stock ran out | Orders cancelled; full automatic refund created |
| Unknown reference | Recorded as `unknown_payment`; nothing changes |

Automatic refunds are created as **approved refund records**. Sending them
to the provider is Stage I (`refunds-process`); a refund record is never
reported as a completed refund.

## Ledger

* Double-entry, append-only, and zero-sum per transaction (deferred
  constraint trigger).
* Amounts are `bigint` JMD cents. Debits are positive, credits negative.
* A captured payment posts `platform_clearing +total` and, for each seller,
  `seller_payable −order total`.
* There is **no commission** (D4 undecided). Payouts are not implemented
  (D7, provider support).
* Seller accounts are per community (D1). `owner_user_id` has no foreign
  key, so financial history survives an account deletion pseudonymously,
  like audit logs.

## Privacy

* Addresses are owner-only.
* A seller sees an order, and the buyer's contact and delivery snapshot,
  **only after it is paid**, and only their own orders.
* Buyers can read their own payments but not provider references.
* Payment events, webhook events, the ledger and test-provider state are
  server-only.
* Notifications carry no payment data.

## Configuration (Edge Function secrets, never committed)

| Secret | Meaning |
|---|---|
| `PAYMENTS_MODE` | `test`. Nothing else is accepted until a real provider is added. |
| `PAYMENTS_TEST_SECRET` | At least 32 random characters: the test provider's signing key |
| `PAYMENTS_RETURN_URL` | Default `communione://payment-return` |

`supabase/config.toml` sets `verify_jwt = false` for the webhook, reconcile
and test-checkout functions. They authenticate by signature or by the
service-role bearer themselves. `payments-reconcile` must be scheduled
(for example with `pg_cron` + `pg_net`, or an external scheduler) every
5 minutes. **That schedule is not set up in any hosted project yet.**

## Not done / waiting

* A real provider adapter (PowerTranz / WiPay): waiting for merchant
  application, sandbox credentials and D2–D3.
* Hosted deployment of the Edge Functions and their secrets: not done.
  Migrations 33–35 have not been applied to any hosted project by this work.
* Offline payment (cash on pickup, D11): not implemented.
* Coupons and discounts: the `discount_minor` column exists and is always 0.

## Tests

| Layer | File | Count |
|---|---|---|
| pgTAP | `033_marketplace_cart` | 19 |
| pgTAP | `034_marketplace_checkout` | 34 |
| pgTAP | `035_marketplace_payments` | 42 |
| Node + real local stack | `tests/services/cart.test.ts` | 3 |
| Node + real local stack | `tests/services/checkout.test.ts` | 4 |
| Node + real local stack | `tests/services/payments.test.ts` | 10 |
| App (jest) | `features/marketplace/commerce.test.tsx` | 7 |

The payments test drives the real handlers with the test provider:

* sessions;
* the hosted page;
* signed, replayed, forged, stale and unsigned webhooks;
* decline and retry;
* amount mismatch;
* reconciliation of a lost webhook;
* a late payment refunded automatically;
* privacy.

App tests stub the checkout, order and payment service methods. Their rules
are covered by the database and integration tests above.

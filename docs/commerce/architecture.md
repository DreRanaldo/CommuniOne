# Commerce Architecture Assessment

## What exists today (reused, not duplicated)

| Capability | Existing piece | How commerce uses it |
|---|---|---|
| Identity | Supabase Auth; `private.current_active_user_id()` (live session, active account) | Every commerce operation is attributed to it. Buyer and seller ids are never taken from the client. |
| Tenancy | `communities`, `memberships`; `has_community_permission(community, key)` | Listings, carts and orders belong to one community (decision D1). Buying and selling need an active membership and a permission. |
| Permissions | `permissions`, role templates, `role_permissions`; anti-escalation and cover rules | New keys: `marketplace.view`, `marketplace.buy`, `marketplace.sell`, `marketplace.manage`. They are added to the templates by migration, as migration 31 did for `alerts.create`. |
| RLS pattern | Explicit column grants; SECURITY DEFINER functions with `search_path = ''`; `private` schema helpers | Same pattern. Money-moving writes go only through functions; tables get no client INSERT or UPDATE grants. |
| Private files | Private buckets with own-folder upload policies and signed URLs (`post-images`, `alert-images`) | A `listing-images` bucket uses the same layout and rules (`{community}/{user}/{uuid}.jpg`). |
| Idempotency | `posts.client_request_id` unique per author (migration 26) | `checkouts.client_request_id` unique per buyer, so a retried "Place order" returns the same checkout. |
| Rate limits | `private.rate_limit_rules` and the trigger adapter (migration 21) | New actions: `listing.create`, `checkout.create`, `refund.request`, `booking.request`. |
| Notifications | `private.create_notification()` / `notify_community()`, `notification_types`, per-community preferences | New types: `order`, `payment`, `delivery`, `booking`, `refund`, `dispute`. They are personal, never community-wide broadcasts, and carry no payment data. |
| Audit | `private.record_audit_event()`, `audit_actions` catalog, append-only `audit_logs` | Every order, payment, refund, inventory and admin transition is audited. Secrets are never recorded. |
| Concurrency | Row locks with `for update`; race tests (`invitation-race.sh`, `rsvp-stress.sh`) | Inventory reservation and booking slots use the same technique, with the same kind of stress test. |
| Service layer | `services/*` (TypeScript), `ServiceError`, keyset pagination | New `services/marketplace`, `cart`, `orders`, `payments`, `bookings` modules. Screens never call Supabase directly. |
| Mobile app | Expo SDK 57, React Navigation, `useServices()`, permission hints, fake backend tests | A Market tab (currently a placeholder) becomes the storefront. Seller tools follow the RN-16 admin-tool pattern. |
| CI | Lint, typecheck, unit tests, pgTAP on plain Postgres and on Supabase, integration, mobile verify | Commerce adds pgTAP files, race tests, service tests, and unit tests for the payment adapter and webhook verifier. |

## What is missing and must be built

1. **A trusted server runtime with secrets.** Provider API calls and webhooks
   need the provider's secret key, which must never ship in the app.
   - CommuniOne has no Edge Functions yet (`docs/architecture/service-layer.md` reserves them for exactly this).
   - Plan: **Supabase Edge Functions** (`supabase/functions/`):
     - `payments-session`: creates a provider payment session for a checkout the database already priced;
     - `payments-webhook`: receives provider callbacks;
     - `payments-reconcile`: scheduled, polls pending payments;
     - `refunds-process`: sends approved refunds to the provider.
   - Secrets are stored with `supabase secrets set`, never in git, the app, logs or the database.
   - Edge Functions use the service role only to call SECURITY DEFINER functions that are granted to `service_role` alone.
2. **All commerce tables** ([`data-model.md`](data-model.md)).
3. **A double-entry ledger** for money (immutable). Order totals are snapshots, not the financial record.
4. **A payment adapter** with a deterministic test provider for CI and a real provider adapter once credentials exist ([`payments.md`](payments.md)).
5. **An in-app browser for hosted checkout.** `expo-web-browser` opens the provider's page, then returns via the `communione://` scheme. This is one new SDK-matched dependency, added in Stage E.
6. **Admin Web.** It does not exist. Marketplace administration (disputes, payouts, policies) starts as mobile admin tools for community managers and as SQL or runbooks for platform operators. The Admin Web application remains a separate future project.

## Where each responsibility runs

```
 React Native app (untrusted)
   │  browse, cart, "Place order", open hosted payment page, show status
   │  NEVER: prices, totals, stock, payment success, secrets
   ▼
 Supabase Data API + RPCs (RLS, SECURITY DEFINER, transactions)
   │  listings, cart, checkout_create(): price, tax, delivery fee and stock
   │  reservation in ONE transaction; order state machine; refunds requested;
   │  bookings with exclusion constraints; ledger postings (server-only fns)
   ▼
 Edge Functions (trusted, hold provider secrets; service role)
   │  payments-session  → provider API (amount read from the DB, not the app)
   │  payments-webhook  ← provider (signature verified, deduplicated)
   │  payments-reconcile (schedule) → provider status API for stuck payments
   │  refunds-process   → provider refund API
   ▼
 Payment provider (hosted page / 3-D Secure; card data never touches CommuniOne)
```

**Trust rule:** an order becomes **paid** only through
`private.apply_payment_event()`, called by an Edge Function after it has
verified the provider's signature or queried the provider's API. The app's
success screen only shows what the database says.

## Products and services are different

| | Product | Service |
|---|---|---|
| Listing detail | Condition, stock, delivery or pickup options | Pricing model (fixed, quote, hourly), duration, service area, portfolio |
| Purchase | Cart, then checkout | Booking request, then provider acceptance, then payment of the deposit or full price where required |
| Fulfillment | Seller order: processing, ready or shipped, delivered | Booking: confirmed, in progress, completed and confirmed by the customer |
| Capacity | Inventory (reserved stock) | Availability windows; no overlapping bookings (exclusion constraint) |

Both share listings, categories, seller profiles, payments, refunds, the
ledger, disputes and notifications.

## Multi-seller carts

**A checkout is the parent** and holds:
- one payment;
- the buyer's snapshot of totals.

**It splits into one seller order per seller** (`orders`). Each seller order has:
- its own items;
- its own fulfillment method and address snapshot;
- its own status, events and refunds.

**Who sees what:**
- A seller sees only their own orders.
- The buyer sees the checkout and every order in it.
- Partial refunds are per seller order and per item.

The ledger credits each seller separately.

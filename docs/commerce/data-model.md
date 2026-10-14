# Commerce Data Model

This model is reconciled with the existing schema:
- **Reused:** `communities`, `memberships`, `profiles`, `permissions` and roles, `notifications`, `audit_logs`, rate limits and storage. Nothing is duplicated.
- **New tables** live in `public` (RLS on, explicit grants). Server-only helpers live in `private`.
- Each stage adds only the tables it needs, through migrations.

## Conventions

- **Keys:** UUID primary keys. Composite foreign keys `(id, community_id)` where the tenant must match, as `post_images` does.
- **Money:** `bigint` **minor units** (JMD cents), with a `currency char(3)` beside every amount. Never `float` or `numeric` from the client.
  - A checkout has exactly one currency (D10).
  - Totals are **computed by the database** and stored as **immutable snapshots**.
- **Status columns:** `text` with a `check` constraint. Transitions go only through SECURITY DEFINER functions that apply the state machines in [`lifecycles.md`](lifecycles.md).
  - Clients have **no** UPDATE grant on status, price or total columns.
- **Timestamps:** `timestamptz` everywhere. Financial rows (order items, payments, refunds, ledger) are **append-only or immutable once final**, enforced by triggers, like `audit_logs`.
- **Personal data:** addresses and phone numbers are owner-only, as in `profile_private`. A seller order carries an address **snapshot** visible to that order's buyer and seller only.

## Catalog (Stage B)

| Table | Key columns | Notes |
|---|---|---|
| `market_categories` | `id`, `parent_id`, `slug` (unique), `name`, `kind` (`product` / `service` / `both`), `sort_order`, `active` | Platform-wide, seeded by migration, readable by authenticated users |
| `seller_profiles` | `id`, `community_id`, `user_id` (unique together), `display_name`, `bio`, `status` (`active` / `paused` / `suspended`), `verification_status` (`unverified` / `pending` / `verified` / `rejected`), `accepts_online_payment` | One per seller per community. Verification is set by platform operators only (D8). |
| `listings` | `id`, `community_id`, `seller_profile_id`, `seller_user_id`, `kind` (`product` / `service`), `category_id`, `title`, `description`, `condition` (`new` / `like_new` / `good` / `fair` / null for services), `price_minor` (≥ 0), `currency`, `status` (`draft` / `active` / `paused` / `sold_out` / `removed`), `fulfillment` (`pickup` and/or `seller_delivery`), `pickup_area`, `search` (tsvector, generated), `created_at`, `updated_at` | The price is the seller's current price. Orders snapshot it. Full-text index on `search`. |
| `listing_images` | `listing_id`, `community_id`, `storage_path` (unique), `position` (0–9), `width`, `height` | Private `listing-images` bucket, own-folder uploads (as in post-images) |
| `inventory` | `listing_id` (PK), `on_hand` (≥ 0), `reserved` (≥ 0), check `reserved <= on_hand`, `low_stock_threshold` | Products only. Row-locked (`for update`) at reservation. `available = on_hand - reserved`. |
| `inventory_movements` | `id`, `listing_id`, `delta`, `reason` (`restock` / `sale` / `reservation_release` / `adjustment` / `return`), `actor`, `order_id` | Append-only stock history |
| `favorites` | `user_id`, `listing_id` (PK together), `created_at` | Owner-only |

## Cart and checkout (Stages C and D)

| Table | Key columns | Notes |
|---|---|---|
| `carts` | `id`, `user_id`, `community_id` (unique together) | One active cart per buyer and community |
| `cart_items` | `cart_id`, `listing_id` (PK together), `quantity` (1–99), `added_at` | **No price column**: prices are always read from `listings` when shown or checked out. |
| `addresses` | `id`, `user_id`, `label`, `recipient_name`, `phone`, `line1`, `line2`, `town`, `parish` (the 14 Jamaican parishes), `instructions`, `is_default` | Owner-only (like `profile_private`) |
| `delivery_options` | `id`, `seller_profile_id`, `method` (`pickup` / `seller_delivery`), `fee_minor`, `parishes` (text[]), `estimated_days_min/max` (nullable), `active` | The seller sets these; the server calculates the fee. A null estimate is never invented. |
| `tax_rates` | `id`, `code` (e.g. `GCT_STANDARD`), `rate_bps`, `effective_from`, `effective_to` | Owner-configured (D9). `seller_profiles.gct_registered` decides whether it applies. |
| `checkouts` | `id`, `community_id`, `buyer_user_id`, `client_request_id` (unique with buyer), `currency`, `subtotal_minor`, `delivery_minor`, `discount_minor`, `tax_minor`, `total_minor`, `status`, `reservation_expires_at`, `terms_version`, `created_at` | Parent of the seller orders. Totals are immutable. |
| `orders` | `id`, `checkout_id`, `community_id`, `buyer_user_id`, `seller_user_id`, `seller_profile_id`, `status`, `fulfillment_method`, `delivery_option_id`, `address_snapshot` (jsonb), `buyer_contact_snapshot`, `subtotal_minor`, `delivery_minor`, `tax_minor`, `discount_minor`, `total_minor`, `cancellable_until`, `created_at` | One per seller per checkout. Seller orders are `orders`; the parent is `checkouts`. |
| `order_items` | `id`, `order_id`, `listing_id`, `title_snapshot`, `unit_price_minor`, `quantity`, `tax_minor`, `line_total_minor`, `image_path_snapshot` | Immutable after insert |
| `order_events` | `id`, `order_id`, `from_status`, `to_status`, `actor_user_id` (null = system), `reason`, `created_at` | Append-only history; feeds the timeline |
| `inventory_reservations` | `id`, `checkout_id`, `listing_id`, `quantity`, `status` (`held` / `committed` / `released`), `expires_at` | Holds stock while a payment is in progress |

## Payments (Stages E and F)

| Table | Key columns | Notes |
|---|---|---|
| `payments` | `id` (also the provider idempotency key), `checkout_id`, `provider`, `mode` (`test` / `sandbox` / `live`), `provider_reference` (unique with provider), `amount_minor`, `currency`, `status`, `failure_code`, `created_at`, `confirmed_at` | Several attempts per checkout are allowed; at most one `succeeded` (partial unique index). |
| `payment_events` | `id`, `payment_id`, `source` (`webhook` / `reconcile` / `session`), `status`, `amount_minor`, `occurred_at`, `raw_sha256` | Append-only. No raw card data and no secrets. |
| `webhook_events` | `id`, `provider`, `provider_event_id` (unique with provider), `received_at`, `signature_valid`, `processed_at`, `outcome` (`applied` / `duplicate` / `deferred` / `rejected` / `error`), `attempts` | The idempotency guard for callbacks |

## Fulfillment and delivery (Stages G and H)

| Table | Key columns | Notes |
|---|---|---|
| `deliveries` | `id`, `order_id` (unique), `method`, `carrier` (null for the seller), `tracking_number`, `status`, `estimated_from`, `estimated_to` (nullable), `delivered_at`, `proof_path` (nullable) | Ready for courier adapters later |
| `delivery_events` | `id`, `delivery_id`, `status`, `note`, `source` (`seller` / `buyer` / `courier` / `system`), `occurred_at` | Real events only, never invented |
| `pickup_codes` | `order_id`, `code_hash`, `confirmed_at` | The buyer shows a code at pickup; only its hash is stored. |

## Refunds, disputes (Stage I)

| Table | Key columns | Notes |
|---|---|---|
| `refund_policies` | `id`, `community_id` (null = platform default), `kind`, `rules` (jsonb: windows, eligible states, restocking), `version`, `approved_by`, `approved_at` | Owner-configured (D6). The code invents no policy text. |
| `refunds` | `id`, `order_id`, `payment_id`, `requested_by`, `reason`, `amount_minor`, `currency`, `status`, `provider_refund_reference`, `created_at` | A request is **not** a refund until the provider confirms. |
| `refund_items` | `refund_id`, `order_item_id`, `quantity`, `amount_minor` | Partial refunds by item and quantity |
| `refund_events` | Append-only status history | |
| `disputes` | `id`, `order_id` or `booking_id`, `opened_by`, `reason`, `status` (`open` / `awaiting_seller` / `awaiting_buyer` / `resolved` / `escalated`), `resolution` | Operator-visible |
| `dispute_messages` | `dispute_id`, `author_user_id`, `body`, `created_at` | Parties and operators only |

## Services and bookings (Stage J)

| Table | Key columns | Notes |
|---|---|---|
| `service_details` | `listing_id` (PK), `pricing_model` (`fixed` / `hourly` / `quote`), `duration_minutes`, `deposit_minor` (nullable), `service_area` (parishes), `buffer_minutes` | Extends a `kind = 'service'` listing |
| `availability_rules` | `id`, `listing_id`, `weekday`, `start_time`, `end_time`, `timezone` | Weekly availability |
| `availability_exceptions` | `id`, `listing_id`, `starts_at`, `ends_at`, `kind` (`closed` / `extra`) | |
| `bookings` | `id`, `community_id`, `listing_id`, `provider_user_id`, `customer_user_id`, `slot tstzrange`, `status`, `quote_minor`, `deposit_minor`, `total_minor`, `checkout_id` (nullable) | **Exclusion constraint** (`btree_gist`): no overlapping `slot` per provider while the status is requested, proposed, accepted, confirmed or in progress. |
| `booking_events` | Append-only history, including proposed alternative times | |

## Money ledger and payouts (Stages F and K)

| Table | Key columns | Notes |
|---|---|---|
| `ledger_accounts` | `id`, `kind` (`platform_clearing` / `seller_payable` / `platform_revenue` / `processor_fees` / `refunds_payable`), `owner_user_id` (sellers), `currency` | |
| `ledger_transactions` | `id`, `kind` (`payment_captured` / `refund` / `payout` / `fee` / `adjustment`), `reference_type`, `reference_id`, `created_at` | |
| `ledger_entries` | `id`, `transaction_id`, `account_id`, `amount_minor` (signed), `currency` | Double-entry: a deferred constraint trigger requires each transaction to **sum to zero**. Append-only; corrections are new transactions. |
| `payouts` | `id`, `seller_user_id`, `amount_minor`, `currency`, `status` (`scheduled` / `processing` / `paid` / `failed` / `cancelled`), `method`, `reference`, `period_from/to` | Stage K, only after D2–D8 |
| `marketplace_settings` | `community_id` (PK), `enabled`, `offline_payment_allowed`, `commission_bps` (null until decided), `terms_version` | Per community (D1) |

## New permission keys

| Key | Meaning | Default templates |
|---|---|---|
| `marketplace.view` | Browse listings in this community | Member and up |
| `marketplace.buy` | Use the cart and check out | Member and up |
| `marketplace.sell` | Create listings and receive orders | Member and up (owner may restrict) |
| `marketplace.manage` | Moderate listings, see disputes, run policies (not other people's payment details) | Admin, Owner |

Private data (addresses, payment references, seller balances) is guarded by
ownership rules (buyer, the order's seller, platform operator), not by these
keys alone.

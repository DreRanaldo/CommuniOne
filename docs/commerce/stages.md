# Implementation Stages

Each stage ships through migrations, services, the app, tests and docs.

**After each stage:**
1. run every check;
2. document migrations and manual configuration;
3. report what was done and what is outstanding;
4. **stop for approval**.

**Every stage runs:** lint, typecheck, migrations from scratch, pgTAP on both
runners, service and integration tests, mobile verify (including the
production export) and CI.

| Stage | Scope | Tests | Done when |
|---|---|---|---|
| **A** | Architecture, provider assessment, data model (this folder) | — | Owner reviewed; decisions D1–D11 recorded |
| **B** | `marketplace.*` permissions; categories (seed); seller profiles; listings (product and service) with images (private bucket) and inventory; search (full-text), filter (category, price, condition, kind), sort; favorites. App: Market storefront (white, Amazon-inspired), listing page with gallery, seller page, "Sell" workflow (create, edit, stock, pause). | pgTAP: RLS per role, cross-community sweep, image path rules, inventory constraints. Service tests. App tests: browse, search, filter, favorite, seller CRUD, permission hiding. | Members browse and sell in their own community only; no cart yet |
| **C** | Cart and cart items; `cart_quote()` (server price, stock and availability per line; warnings for changes) | Price-tamper tests (the client cannot send prices); stock and availability changes; cross-community items refused | Cart persists across devices; every number shown comes from the server |
| **D** | Addresses (owner-only); delivery options and fees; tax rates; `checkout_create()` (one transaction: price, tax, fees, reserve stock, create checkout and seller orders, idempotent); terms version; offline-payment option if D11 approved; order history and detail; reorder | Concurrency stress (no oversell); duplicate submit; price-changed confirmation; reservation expiry; seller isolation of order data | Orders exist in `pending_payment` (or `confirmed_offline`); no online payment yet |
| **E** | Edge Functions; payment adapter; **test provider**; `payments-session`, `payments-webhook` (signature, dedupe); in-app browser return; real provider adapter **if** sandbox credentials exist | Unit: adapter, HMAC verification, forged and expired signatures, replay. Integration: session, approve, decline, timeout, duplicate webhook. | End to end with the test provider; sandbox status documented honestly |
| **F** | `apply_payment_event()`; order state machine; ledger postings for captures; reconciler (schedule); amount-mismatch handling; late-payment rules | State-machine pgTAP (every allowed and forbidden transition); reconciliation after a lost webhook; client disconnect; ledger sums to zero | Paid orders are confirmed only by verified events |
| **G** | Seller order inbox: accept or reject, prepare, mark ready or shipped; seller history; buyer timeline | Seller A cannot read or act on seller B's orders; transitions per role | Sellers fulfil end to end |
| **H** | Deliveries, pickup codes, delivery events, failed delivery, buyer confirmation; courier abstraction (no courier yet) | Delivery transitions; pickup code checks; no invented events | Truthful status-based tracking |
| **I** | Refund policies (owner-approved), requests, approval, automatic refunds (rejected or out of stock), provider refunds (test provider; sandbox if available), partial refunds, disputes | Eligibility, over-refund prevention, pending and failed refunds, retries, ledger | Refunds reach "succeeded" only on provider confirmation |
| **J** | Service details, availability, bookings (exclusion constraint), proposals, deposits through checkout, rescheduling, completion and disputes | Double-booking stress test; cancellation rules; deposit payment | Services work without the shipping flow |
| **K** | Seller balances from the ledger; payout records; reports; payout integration **only if** the provider supports it and D2–D8 are approved | Ledger reconciliation reports; negative balances; payout idempotency | Interim manual settlement documented and approved, or provider payouts working in sandbox |
| **L** | Notification types and preferences for commerce; audit catalog; support and dispute tools for operators | Duplicate-notification tests; no sensitive data in notifications or audit | Every party is informed of every change that concerns them |
| **M** | End-to-end tests, security review, recovery drills (lost webhooks, provider outage), docs, status matrix | Full suite plus a security review | Status matrix truthful; live readiness checklist |

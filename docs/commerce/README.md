# CommuniOne Marketplace and Commerce

Design (Stage A) and the implementation notes of each stage. **No real money moves:** only a test payment provider exists.

**Goal:** an Amazon-inspired marketplace inside CommuniOne. It covers:
- products and services;
- search, cart and checkout;
- online payment;
- orders, fulfillment and delivery;
- refunds;
- service bookings;
- seller settlement.

It is built in small stages (B to M), each tested and approved before the next.

| Document | What it answers |
|---|---|
| [`architecture.md`](architecture.md) | What exists today, what must be built, where each piece runs, trust boundaries |
| [`payments.md`](payments.md) | Payment providers for Jamaica, the adapter, sessions, webhooks, reconciliation, refunds, settlement models |
| [`data-model.md`](data-model.md) | Tables, keys, constraints and money rules, reconciled with the existing schema |
| [`lifecycles.md`](lifecycles.md) | State machines: checkout, payment, seller order, delivery, refund, booking |
| [`security.md`](security.md) | Authorization, privacy, idempotency, failure handling, audit and notifications |
| [`stages.md`](stages.md) | Stages B to M: scope, tests, completion criteria |

## Status (kept current at every stage)

| Capability | Status |
|---|---|
| Design (this folder) | Done (Stage A) |
| Listings, categories, seller profiles, inventory, search, favorites | **Implemented and tested (B)**: see [`stage-b-catalog.md`](stage-b-catalog.md) |
| Cart and server-side price/stock validation | **Implemented and tested (C)**: see [`stage-c-f-checkout-payments.md`](stage-c-f-checkout-payments.md) |
| Checkout, addresses, delivery choices, orders | **Implemented and tested (D)** |
| Payment provider: adapter and test provider | **Implemented and tested in TEST MODE only (E)**: no real money moves |
| Payment provider: real sandbox | **Waiting for merchant application and sandbox credentials** |
| Live payments | **Waiting for merchant approval and owner decisions**; not operational |
| Reconciliation, payment state machine, ledger | **Implemented and tested (F)** against the test provider; reconcile schedule not deployed |
| Seller fulfillment, delivery, pickup | **Implemented and tested (G, H)**: see [`stage-g-h-fulfillment.md`](stage-g-h-fulfillment.md). Tracking is seller-recorded only. |
| Refunds, cancellations, disputes | **Implemented and tested (I) with the test provider**: see [`stage-i-refunds-disputes.md`](stage-i-refunds-disputes.md). Real refunds depend on a real provider. |
| Service bookings | **Implemented and tested (J)**: see [`stage-j-bookings.md`](stage-j-bookings.md). Payment in test mode. |
| Seller balances, statements, payout records | **Implemented and tested (K)**: ledger figures; payouts are operator-recorded only. See [`stage-k-m-settlement-operations.md`](stage-k-m-settlement-operations.md) |
| Automatic seller payouts / split payments | **Not implemented**: blocked on provider support and owner decisions (D2, D4–D8). No escrow is claimed. |
| Commerce notifications, audit, dispute tools | **Implemented and tested (L)** |
| Concurrency stress, recovery drills, security sweep | **Implemented and tested (M)**; external security review still required |
| Deployment of Edge Functions, secrets and schedules | **Not done** for any hosted project: see [`operations.md`](operations.md) |
| Courier integration, live GPS tracking | **Dependent on a third-party courier API**; not planned until one is chosen |

**Not production-ready.** Live payments, real refunds, payouts, the
deployed schedules and an external security review are all still missing;
see the live checklist in [`operations.md`](operations.md).

## Decisions the owner must make

The plan works without these until the stage named. Real money cannot move
until D1 to D8 are decided.

| # | Decision | Needed by | Recommendation |
|---|---|---|---|
| D1 | **Scope:** per community or platform-wide? | B | **Decided (owner, 2026-10-14): per community.** Listings, carts, orders and bookings belong to one community; only its active members (with `marketplace.*` permissions) see, buy or sell there. |
| D2 | **Payment provider and merchant of record.** Is CommuniOne's business the merchant that collects payments for sellers, or does each seller collect their own? | E | Apply to PowerTranz (formerly First Atlantic Commerce) through a Jamaican acquiring bank, and ask WiPay in parallel. Before applying, ask both whether a **marketplace that collects for third-party sellers** is allowed under their merchant terms. See [`payments.md`](payments.md). |
| D3 | **Legal check.** Does collecting money for sellers and paying them later need Bank of Jamaica authorization (Electronic Retail Payment Services guidelines) or other licensing? | E (before live) | A Jamaican lawyer and the acquiring bank must confirm. Do not go live without it. |
| D4 | Platform commission and seller fees | K (before live) | Undecided: a business decision. |
| D5 | Who pays card-processing fees | K | Undecided |
| D6 | Refund, return and chargeback responsibility; the return window | I | Undecided. The code makes the policy configurable and invents none. |
| D7 | Payout timing, holds, and handling of negative seller balances | K | Undecided |
| D8 | Seller identity and business verification (TRN, ID, GCT registration) | Before live sellers | Undecided: legal and tax |
| D9 | **Tax.** Is GCT charged, and by whom? (Sellers below the registration threshold may not charge it.) | D | Configurable per seller, with a tax rate table. Owner and accountant confirm. |
| D10 | Currencies: JMD only, or JMD and USD | D | JMD only at first: one currency per checkout. |
| D11 | Cash on delivery or pickup ("pay the seller directly") as an interim option | D | Allowed only as a clearly labelled offline payment, recorded but not processed by CommuniOne. Owner decides. |

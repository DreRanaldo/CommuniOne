# Commerce Security and Failure Handling

## Trust boundaries

| Never trusted from the app | Decided where |
|---|---|
| Prices, delivery fees, discounts, taxes, totals | `checkout_create()` reads `listings`, `delivery_options` and `tax_rates` inside one transaction |
| Stock | `inventory` row locks, so a checkout reserves or fails as a whole |
| Buyer, seller, community | The session user (`current_active_user_id()`); a listing's own community and seller |
| Payment success | Verified webhook or provider API only (`apply_payment_event()`) |
| Order and delivery status | State-machine functions check the actor's role for each transition |
| File paths | Own-folder storage policies; database checks the file exists |

## Authorization

- **Buyers** read their own checkouts, orders, payments (status only), refunds and bookings.
- **Sellers** read only orders where they are `seller_user_id`. They see the address snapshot and contact details of **those** orders only. They never see the buyer's other orders, payment references or card details.
- **Community managers** (`marketplace.manage`) can moderate listings and see disputes. They cannot see addresses or payments of orders they are not party to, unless a dispute grants access to that order.
- **Platform operators** use the service role in runbooks or functions, which are audited. There is no client-side super-user.
- **Communities stay separate.** Every row carries `community_id`, and composite foreign keys keep children in the same community. RLS requires an active membership, and pgTAP runs cross-tenant sweeps over every new table and RPC, as `022_security_sweep` does.

## Idempotency and concurrency

| Risk | Control |
|---|---|
| Double "Place order" | `checkouts (buyer_user_id, client_request_id)` unique; a retry returns the existing checkout |
| Overselling | `inventory` row lock; `reserved <= on_hand` check; reservations expire; a stress test with concurrent checkouts asserts no oversell |
| Double payment session | The payment id is the provider idempotency key; an existing valid session is reused |
| Duplicate or replayed webhooks | `webhook_events` unique on the provider event id; signature and timestamp checked; the state machine ignores repeats |
| Double booking | Exclusion constraint plus row lock; stress test |
| Double refund | The sum of refunds must not exceed the amount paid (checked under lock); refund id is the provider idempotency key |
| Editing financial history | Order items, payments, payment events, refunds and ledger entries are append-only or immutable once final (triggers); corrections are new records |

## Failure handling

See [`payments.md`](payments.md) section 4 for payment failures. Other failures:

| Situation | Handling |
|---|---|
| A listing changes price while it sits in a cart | Checkout shows the server's current price. A changed total needs the buyer's confirmation (the `expected_total_minor` check); otherwise checkout refuses with `PRICE_CHANGED`. |
| Stock runs out during checkout | The whole checkout is refused with the items affected; nothing is reserved. |
| Stock runs out between payment and fulfilment | Not possible: stock is reserved before payment and committed at payment. A late payment after expiry follows the payments.md rule (re-reserve, or an automatic refund). |
| A seller does not act on a paid order | Reminders, then automatic cancellation and refund after N days (D6, configurable). |
| An Edge Function crashes mid-way | Database work is transactional; webhooks are retried by the provider and are idempotent; the reconciler finishes stuck states. |
| The provider is down | Checkout stays `awaiting_payment`; reservations expire normally; the app says payment is unavailable and keeps the cart. |

## Privacy and secrets

- No card data, CVV or provider secrets in the database, the app, logs, audit metadata or the repository. CI's secret scan already guards the repo, and `config:check` guards the app.
- Webhook payloads are reduced to the fields needed plus a SHA-256 hash.
- Addresses and phone numbers are visible only to their owner and to the seller of an order that uses them (as a snapshot).
- Notifications name the order and its state, never amounts with card details, never addresses.

## Audit and notifications

**Audit actions** (added to `audit_actions`):
- `listing.created/updated/removed`, `inventory.adjusted`;
- `checkout.created`;
- `payment.succeeded/failed/mismatch`;
- `order.status_changed`;
- `refund.requested/approved/rejected/succeeded/failed`;
- `booking.status_changed`;
- `payout.*`;
- `dispute.*`;
- `marketplace.settings_changed`.

**Notification types** (personal, never broadcast):

| Type | Recipient | When |
|---|---|---|
| `order` | seller | new paid order |
| `order` | buyer | accepted, ready, out for delivery, delivered |
| `payment` | buyer | confirmed or failed |
| `refund` | buyer | each status |
| `booking` | both parties | request, change, confirmation |
| `dispute` | both parties | updates |

**Duplicates:** notifications are created inside the same transaction as the
transition, so a duplicate webhook (no transition) sends nothing.

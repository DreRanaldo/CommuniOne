# Lifecycles (State Machines)

Every transition is applied by a SECURITY DEFINER function in the database. It:
- checks who is acting;
- checks the current status, under a row lock;
- writes an event row;
- posts ledger entries where money moves;
- sends notifications;
- records audit events.

Anything not listed is refused (`22023` invalid transition, or `42501` not
allowed). Final states never change.

## Checkout (parent)

```
created ──► awaiting_payment ──► paid ──► (seller orders proceed)
               │   ▲                │
               │   └ retry          └► partially_refunded / refunded
               ├► payment_failed ──► (retry while reservation valid) ─► awaiting_payment
               ├► expired      (reservation ended, nothing paid; stock released)
               └► cancelled    (buyer cancelled before paying)
offline (D11): created ──► confirmed_offline ──► …   (no payment record; clearly labelled)
```

## Payment attempt

```
pending ──► requires_action (3-D Secure) ──► succeeded
   │              │                             └► (refunds tracked separately)
   ├► failed      ├► failed
   ├► cancelled   ├► expired
   ├► expired
   └► unknown ──► succeeded | failed   (resolved by reconciliation only)
```

- Only verified provider events or reconciliation change a payment.
- At most one `succeeded` attempt per checkout. A second success (rare double-pay) triggers an automatic refund of the extra payment.

## Seller order (product)

| From | To | Who |
|---|---|---|
| `pending_payment` | `paid` | system (payment applied) |
| `pending_payment` | `cancelled` | system (checkout expired or failed) |
| `paid` | `accepted` | seller |
| `paid` | `rejected` | seller (with a reason). Triggers an automatic full refund for that seller order. |
| `paid` | `cancelled` | buyer, while `cancellable_until` and not yet accepted. Triggers a refund. |
| `accepted` | `processing` | seller |
| `processing` | `ready_for_pickup` | seller (pickup) |
| `processing` | `out_for_delivery` | seller (delivery) |
| `ready_for_pickup` | `completed` | buyer confirms, or seller confirms with the pickup code |
| `out_for_delivery` | `delivered` | seller, or later a courier event |
| `out_for_delivery` | `delivery_failed` | seller or courier |
| `delivery_failed` | `out_for_delivery` | seller (re-attempt) |
| `delivery_failed` | `cancelled` | operator or seller, with a refund per policy |
| `delivered` | `completed` | buyer confirms, or automatic after N days (D6) |
| `accepted` / `processing` | `cancelled` | seller or operator, with a refund |
| `completed` | `return_requested` | buyer within the policy window (D6); see Refunds |

**Stock:**
- reserved at `created`;
- committed at `paid`;
- released at `cancelled` or `expired`;
- returned to inventory only when a return is received and the seller restocks.

## Delivery (seller-managed first)

```
not_started ─► preparing ─► out_for_delivery ─► delivered
                                   └► failed ─► out_for_delivery | returned_to_seller
pickup: not_started ─► ready ─► collected
```

- Events come from the seller now, and later from a courier adapter's verified webhooks.
- The app shows only recorded events and the seller's estimate, if any.
- **No GPS map** unless a real tracking source exists.

## Refund

```
requested ─► approved ─► processing (sent to provider) ─► succeeded
    │            │                  ├► pending (provider later) ─► succeeded | failed
    │            │                  └► failed ─► processing (retry) | closed_manual
    └► rejected  └► (no money moved yet)
automatic (system): approved ─► processing …   e.g. seller rejected, out of stock after payment
```

- **Eligibility:** `refund_policies` checks the order state, the window, and items and quantities not yet refunded. It never exceeds the amount paid minus refunds already made.
- **Partial refunds:** per item and quantity, or per amount where the provider supports it.
- **Ledger:** posted only at `succeeded`.
- **Status shown to people:** "Refund requested", "Refund approved", "Refund sent to your bank", "Refunded". Never "refunded" before the provider confirms.

## Service booking

```
requested ─► accepted ─► confirmed* ─► in_progress ─► completed ─► closed
    │          │  └► (deposit/payment required → awaiting_payment ─► confirmed)
    │          └► cancelled (either party, per policy)
    ├► proposed_alternative (provider offers other times) ─► requested | declined
    ├► declined (provider)
    └► expired (no answer in time)
completed ─► disputed ─► resolved
*confirmed requires payment only when the listing requires a deposit or full prepayment
```

- **No double-booking.** The exclusion constraint on `(provider, slot)` covers the active statuses.
- **Rescheduling** moves the slot in one transaction, so the old slot is released only if the new one is free.
- **Completion:** the provider marks it complete; the customer confirms or opens a dispute within N days (D6).

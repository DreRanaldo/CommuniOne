# Stages G–H: seller fulfillment, pickup and delivery

**Status:** implemented and tested. Delivery tracking is **only** what the
seller records. No courier integration exists and there is no live GPS:
nothing is invented.

## Order steps (migration 36)

Each step is its own database function. The function checks:

* that the caller is this order's seller (or buyer);
* that the order is in a status the step allows;
* that the seller still has `marketplace.sell`.

Clients have no write access to orders.

| Who | Step | From | To |
|---|---|---|---|
| Seller | `order_accept` | paid | accepted |
| Seller | `order_reject(reason)` | paid | rejected: stock returned, full refund record |
| Seller | `order_start_processing` | accepted | processing |
| Seller (pickup) | `order_ready_for_pickup(note)` | accepted, processing | ready_for_pickup; the buyer gets a 6-digit code |
| Seller (pickup) | `order_confirm_pickup(code)` | ready_for_pickup | completed; a wrong code returns `wrong_code`; 5 wrong codes lock it |
| Seller (delivery) | `order_dispatch(courier, reference, https link)` | accepted, processing, delivery_failed | out_for_delivery |
| Seller | `order_mark_delivered` | out_for_delivery | delivered |
| Seller | `order_mark_delivery_failed(reason)` | out_for_delivery | delivery_failed |
| Seller | `order_seller_cancel(reason)` | accepted … delivery_failed | cancelled: stock returned, full refund record |
| Buyer | `order_buyer_cancel(reason)` | paid (not yet accepted) | cancelled: stock returned, full refund record |
| Buyer | `order_confirm_received` | delivered | completed |
| Job | `expire_unaccepted_orders` (48 h) | paid | cancelled: refund |
| Job | `complete_delivered_orders` (7 days) | delivered | completed |

Every step:

* is written to `order_events`, the history both parties see;
* notifies the other party.

Rejections and cancellations are audited (`order.cancelled`).

The two jobs run from `payments-reconcile`. The 48-hour and 7-day windows
are defaults, **not a return policy**. The owner decides the return
policy (D6).

## Refunds created here

Rejecting or cancelling a paid order creates **one** full refund record
(`automatic`, `approved`) for whatever has not been refunded yet. It is
**not** a completed refund: Stage I sends it to the payment provider and
only the provider's confirmation completes it. A second cancel of the same
order is refused, because the status no longer allows it.

## Privacy

* The pickup code is readable by the buyer only. The seller must hear it at
  handover.
* Shipment details are visible to the order's buyer and seller only.
* The seller sees the buyer's contact and address only on paid orders
  (Stage D rule).

## App

* Market → Orders, with Purchases / Sales tabs (sellers).
* Shop → Sales and Delivery.
* The order page offers the steps allowed now. It shows:
  * the buyer's pickup code;
  * the seller-recorded courier details, marked "as recorded by the seller";
  * the history.

## Tests

| Layer | File | Count |
|---|---|---|
| pgTAP | `036_marketplace_fulfillment` | 47 |
| Node + real local stack | `tests/services/fulfillment.test.ts` | 4 |
| App | `commerce.test.tsx` (fulfillment) | 4 |

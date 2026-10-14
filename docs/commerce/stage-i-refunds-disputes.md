# Stage I: refunds, cancellations and disputes

**Status:** implemented and tested against the **TEST** payment provider.
Real refunds depend on a real provider (D2), which is not connected.

## Rules

* A refund is **complete only when the payment provider confirms it**
  (`refund_apply_result('succeeded')`). The app labels each status:
  * requested — "Requested, waiting for the seller";
  * approved — "Approved, waiting to be sent";
  * processing or pending — "Being processed by the payment provider";
  * succeeded — "Refunded" (the only one that says so);
  * failed — "Refund failed; our team will follow up".
* Refunds can never exceed what was paid on a payment. Requested, approved
  and in-flight refunds count toward the cap, under a row lock.
* Only a completed refund moves money in the ledger:
  * clearing goes down;
  * the seller's payable goes down (for a duplicate payment, platform
    revenue does instead).
  The checkout becomes `partially_refunded` or `refunded`.

## Flows (migration 37)

| Who | Function | Notes |
|---|---|---|
| Buyer | `refund_request(order, reason, amount?)` | Allowed on accepted to completed orders. Before acceptance the buyer cancels instead (Stage G). There is one open request per order, and requests must fall within the community window after completion. Rate limit: 10 per day. |
| Seller | `refund_decide(refund, approve, amount?, note)` | Approve the full amount or less, or decline with a note. Decided once. |
| Buyer | `dispute_open(order, reason)` | One open dispute per order. The seller and the community's `marketplace.manage` holders are notified. Rate limit: 5 per day. |
| Parties, managers | `dispute_add_message` | Append-only thread |
| Manager (not a party) | `dispute_resolve(dispute, refund?, amount, note)` | A refund decision creates an **approved** refund (capped). Open requests are superseded. Audited. |
| Buyer | `dispute_withdraw` | |
| Manager | `refund_policy_save` | Turns requests on or off, sets the window (0–365 days, default 14) and the community's **own** policy text |
| Service role | `refunds_claim`, `refund_apply_result`, `refund_retry` | Used by the `refunds-process` Edge Function and by operators |

`refunds-process` is a scheduled Edge Function that needs the service-role
bearer. It:

* claims approved refunds, and processing or pending ones older than 10
  minutes (`skip locked`, so they are never sent twice at once);
* calls `provider.refund` (idempotent per refund id) and records the
  result;
* puts the refund back in the queue when the provider is unavailable;
* leaves failures for an operator. They are audited, and
  `refund_retry` re-queues them.

**The 14-day window is a default setting, not a return policy.**
CommuniOne publishes no policy wording. A community may publish its own,
and buyers see it as written. The owner must decide D6.

## Not done

* Chargebacks: no provider events exist yet (needs a real provider).
* Return shipping, restocking returned goods after a refund, and
  item-level refunds (`refund_items` exists but is unused): not built.
* Operator console for failed refunds: SQL or service role only.

## Tests

| Layer | File | Count |
|---|---|---|
| pgTAP | `037_marketplace_refunds` | 40 |
| Node + real local stack | `tests/services/refunds.test.ts` | 4 |
| App | `commerce.test.tsx` (refunds and disputes) | 4 |

# Payments: Provider Assessment, Adapter, Webhooks and Settlement

> **Status:** assessment only. Nothing has been integrated. No live or sandbox
> payment works yet. Provider facts below come from public sources found in
> October 2026. The sandbox could not open the providers' own documentation
> sites, so each fact is marked **to confirm** with the provider before
> Stage E.

## 1. Provider options for Jamaica

| Provider | JMD | Integration | Refunds | Marketplace / split payouts | Fit |
|---|---|---|---|---|---|
| **PowerTranz** (formerly First Atlantic Commerce, FAC), through a Jamaican acquiring bank (e.g. NCB eCommerce) | Yes, JMD and USD; local settlement in JMD (to confirm) | Hosted Payment Page (SPI) with 3-D Secure 2; card data stays with the gateway. Separate sandbox (`staging.ptranz.com`) and production credentials: PowerTranz ID, password, Gateway ID. | Refund API (to confirm partial refunds) | **None documented.** One merchant account settles to one business. | **Recommended primary** for card payments in JMD |
| **WiPay** (Caribbean) | Yes (JMD, USD, TTD) | Hosted payment page; API keys need a verified business account; Jamaica endpoint | To confirm | "Bulk payouts" on paid plans (JMD 2,899–7,249/month); **no documented marketplace split API**. Fees 2.5–4.5% by location; settlement to a local bank in 5–7 business days (to confirm). | Good second option; ask specifically about bulk payouts to sellers |
| **Lynk** (Jamaican wallet) | Yes | "Pay with Lynk": the customer approves in the Lynk app; API access by request after business registration | To confirm | None documented | Useful **additional** method later; only for customers with Lynk |
| **Stripe** | n/a | Excellent APIs and Connect marketplaces | Yes | Connect | **Not available to a Jamaican business as merchant.** Cross-border payouts *to* Jamaican bank accounts appeared in a Dec 2025 preview. They need a platform company in a Stripe-supported country. Only an option if the business forms such an entity: a legal and tax decision. |
| **PayPal** | Limited | Checkout | Yes | No | Jamaican accounts can receive, but withdrawing to Jamaican banks is reported as restricted (workarounds via third parties). **Not recommended** as the primary method. |
| Fygaro, others | Varies | Connects to bank merchant accounts | To confirm | Not documented | Alternatives if the bank route is slow |

**Common finding:** no provider found offers documented *marketplace split
payments or automatic seller payouts* in JMD for a Jamaican business. **Stage K
therefore cannot assume automatic payouts** (see section 6).

**Regulation** (to confirm with a lawyer and the acquiring bank):
- **Bank of Jamaica guidelines.** The Electronic Retail Payment Services guidelines (ERPS 2, 2019) require BOJ authorization for entities that *offer* electronic retail payment services. A Payments, Clearing and Settlement Bill that would license payment service providers is pending.
- **Holding money for sellers.** A platform that collects money and holds it for sellers may fall in scope.
- **Bank aggregation rules.** Acquiring banks usually forbid processing payments for other merchants ("aggregation") without a payment-facilitator arrangement.

Both points are **decision D3** and block live marketplace payments.

**Tax.** General Consumption Tax (GCT) is generally 15%. Registration is
required above JMD 15 million of taxable supplies a year (from April 2025),
so many small sellers are not registered and must not charge GCT. To confirm
with Tax Administration Jamaica (TAJ) and an accountant (D9).

### Recommendation

1. **Build the adapter and a test provider first (Stage E).** Everything is tested end to end without real money.
2. **Apply for a PowerTranz merchant account through a Jamaican bank** as soon as the owner decides the merchant-of-record question (D2). In the application, ask explicitly:
   - Is a multi-seller marketplace allowed?
   - Are partial refunds supported?
   - What is the webhook or notification mechanism and its signature method?
   - What is the settlement currency?
3. **Ask WiPay the same questions in parallel**, plus whether bulk payouts can pay sellers.
4. **Implement the chosen provider's adapter against its sandbox** once credentials exist. Live mode stays off until D2–D8 are decided.

## 2. The adapter (server-side, provider-neutral)

The adapter lives in `supabase/functions/_shared/payments/`. It is pure
TypeScript with no Deno-only imports, so `node --test` can unit-test it in CI.

```ts
interface PaymentProvider {
  readonly name: 'test' | 'powertranz' | 'wipay';
  /** A hosted session for an amount the DATABASE computed. Idempotent per key. */
  createSession(input: {
    paymentId: string;           // our payments.id, also the idempotency key
    amountMinor: bigint;         // integer minor units (JMD cents)
    currency: 'JMD' | 'USD';
    description: string;         // no personal data
    returnUrl: string;           // communione://checkout/return?payment=<id>
  }): Promise<{ providerReference: string; redirectUrl: string; expiresAt: Date }>;

  /** Authoritative status from the provider's API (reconciliation). */
  fetchStatus(providerReference: string): Promise<ProviderPaymentStatus>;

  /** Verify a webhook. Throws unless the signature and timestamp are valid. */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedEvent>;

  /** Refund (full or partial). Idempotent per refundId. */
  refund(input: { refundId: string; providerReference: string; amountMinor: bigint }):
    Promise<{ providerRefundReference: string; status: 'pending' | 'succeeded' | 'failed' }>;
}
```

- **Provider choice:** server configuration (`PAYMENTS_PROVIDER`, `PAYMENTS_MODE=test|sandbox|live`). It is never chosen by the app.
- **The test provider** is deterministic. Scripted outcomes (approve, decline, timeout, duplicate webhook, late webhook) are keyed by test card tokens, and its webhooks are HMAC-SHA256 signed with a test secret. It is **refused in live mode**.
- **Switching providers** means adding one adapter; orders, refunds and the ledger do not change.

## 3. Payment flow

1. **Checkout.** The app calls `checkout_create(client_request_id, cart, address, delivery choices)`. The database prices everything, reserves stock, creates the checkout, seller orders, and a payment with status `pending`, all in one transaction.
2. **Payment session.** The app calls the `payments-session` Edge Function with the payment id only. The function:
   - reads the amount from the database;
   - calls `createSession`;
   - stores `provider_reference` (idempotent: a second call returns the same session while it is valid).
3. **Hosted page.** The app opens `redirectUrl` in the in-app browser. The customer pays on the provider's page, with 3-D Secure as needed.
4. **Webhook.** The provider sends a webhook to `payments-webhook`, which:
   - checks the signature;
   - **inserts into `webhook_events`** (unique `provider, provider_event_id`), so duplicates stop here;
   - calls `private.apply_payment_event()`, which moves the payment and checkout through their state machines, commits or releases stock, posts the ledger entries and sends notifications, all in one transaction.
5. **Return to the app.** The provider redirects back to the app. The app **polls the checkout status**. It never assumes success.
6. **Reconciliation.** `payments-reconcile` runs every few minutes. It calls `fetchStatus` for payments still pending or `unknown` after N minutes, and applies the result through the same function. This covers a client disconnect, a lost webhook and a provider timeout.

## 4. Failure handling

| Situation | Handling |
|---|---|
| Declined | Payment `failed`; checkout `payment_failed`; stock released; the buyer may retry, which creates a new payment attempt for the same checkout while the reservation lasts. |
| Customer closes the page | Payment stays `pending` until the session expires; the reconciler marks it `expired` or `cancelled`; stock released. |
| Provider timeout while creating a session | No session stored; the app may retry (same payment id, so idempotent). |
| Timeout or unknown result after paying | Payment `unknown`; **never shown as failed or paid**. The reconciler resolves it; the buyer sees "We're confirming your payment". |
| Duplicate webhook | Unique `webhook_events` row, so a second delivery is a no-op that returns 200. |
| Forged or unsigned webhook | 401; stored only as a rejected attempt (no payload); never applied. |
| Webhook out of order (e.g. refund before capture) | The state machine rejects the invalid transition; the event is kept as `deferred` and retried by the reconciler. |
| Payment succeeds after the reservation expired | Re-reserve if stock allows; otherwise the order is `cancelled_out_of_stock` and an **automatic full refund** is created and tracked. |
| Payment amount differs from the database amount | Never accepted as paid: the payment is flagged `amount_mismatch` for manual review and audited. |
| Provider refund fails | Refund `failed` and visible to admins; retried or handled manually; never shown as refunded. |

## 5. What CommuniOne never stores

- Card numbers, CVV or expiry.
- Provider secrets: those live only in Edge Function secrets.
- Full provider payloads: only the fields needed (reference, status, amount, currency, timestamps), plus a hash of the raw body for audit.

Provider references are not secrets, but they are visible only to the buyer
and to platform operators.

## 6. Seller settlement (Stage K)

**Do not enable real seller payments until D2–D8 are decided.**

| Model | How | Requirements |
|---|---|---|
| **A. Platform as merchant of record, manual settlement** | Customers pay CommuniOne's merchant account. The ledger records what each seller is owed (sale minus commission and fees). The platform pays sellers by bank transfer on a schedule; each payout is recorded in `payouts` and posted to the ledger. | The acquirer must allow marketplace sales. Legal confirmation on BOJ authorization (D3). Seller verification (D8). Written seller terms. |
| **B. Provider bulk payouts** | Like A, but payouts go through the provider (e.g. WiPay bulk payouts). | Provider confirmation, plus A's requirements |
| **C. Seller collects** | Each seller has their own merchant account; CommuniOne only records orders, or offers "pay on pickup/delivery" (offline). | No platform risk; less convenient. CommuniOne processes no money. |
| **D. Stripe Connect via a foreign platform entity** | Connect handles split payouts. | A company in a Stripe-supported country; tax and legal advice |

**Interim recommendation:**
- Ship stages B–J with the **test provider** and, if the owner approves D11, **offline payment** (pay on pickup or delivery), clearly labelled.
- Turn on model A only after the bank and lawyer confirm it.

**There is no escrow.** "Funds held" in the ledger is accounting, not a legal escrow arrangement, and the app must never call it escrow.

## Sources (October 2026; reconfirm with each provider)

- Stripe availability in Jamaica: [Stripe in Jamaica: not available](https://tryhandypay.com/guides/stripe-alternative-jamaica), [Stripe supported countries 2026](https://dodopayments.com/blogs/stripe-supported-countries-alternatives), [Stripe changelog: cross-border payouts new countries (Dec 2025)](https://docs.stripe.com/changelog/clover/2025-12-15/cross-border-payouts-new-countries)
- PowerTranz / First Atlantic Commerce: [FAC developers](https://firstatlanticcommerce.com/developers/), [NCB eCommerce FAQ](https://www.jncb.com/ecommerce/faq.html), [Sitepact: accepting cards in Jamaica](https://sitepactja.com/how-to-accept-credit-card-payments-on-your-woocommerce-store-in-jamaica/), [FAC non-3DS integration example](https://www.c-sharpcorner.com/article/building-a-non-3ds-payment-gateway-integration-with-first-atlantic-commerce-and)
- WiPay: [WiPay Jamaica pricing](https://wipaycaribbean.com/jamaica/pricing), [WiPay API documentation (PDF)](https://wipaycaribbean.com/WiPay-API-Documentation.pdf), [Lynk vs WiPay vs NCB](https://sitepactja.com/mobile-payments-jamaica-lynk-wipay-ncb-ecommerce/)
- Lynk: [Lynk mobile money for Jamaican websites](https://sitepactja.com/lynk-mobile-money-jamaican-website-payments/), [Lynk & Yello e-commerce (Jamaica Observer)](https://www.jamaicaobserver.com/2023/04/18/lynk-and-yello-partners-on-e-commerce-incubator-for-msmes/)
- PayPal in Jamaica: [Does PayPal work in Jamaica in 2026?](https://ezywebpro.com/blog/does-paypal-work-jamaica/), [Wise and PayPal (Jamaica Observer)](https://www.jamaicaobserver.com/2022/11/29/using-wise-to-receive-money-from-paypal-the-world/)
- Regulation: [BOJ Electronic Retail Payment Services guidelines](https://www.boj.org.jm/uploads/news/guidelines_for_electronic_retail_payments_services_-_1_february_2013.pdf), [BOJ legislation (pending payments bill)](https://boj.org.jm/about-boj/legislation/), [BOJ authorised payment service providers](https://boj.org.jm/core-functions/financial-system/payment-systems/authorised-payment-service-providers/)
- Tax: [GCT threshold JMD 15 million](https://beancount.io/blog/2026/10/08/jamaica-gct-exemption-threshold-15-million-msme-digital-services-guide), [Jamaica tax rates](https://payproglobal.com/saas-sales-tax/jamaica/)

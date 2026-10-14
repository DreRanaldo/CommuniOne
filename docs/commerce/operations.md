# Commerce operations runbook

**For operators.** Payments run in **TEST MODE** only. Nothing here moves
real money.

## Deploying (not done for any hosted project yet)

1. Apply migrations 32–39 (`supabase db push`) to the target project after
   review. Do not assume they are applied.
2. Set the Edge Function secrets. Never commit them.
   * `PAYMENTS_MODE=test`. This is the only mode implemented.
   * `PAYMENTS_TEST_SECRET`: 32 or more random characters.
   * `PAYMENTS_RETURN_URL`: optional, default `communione://payment-return`.
3. Deploy the functions:
   * `payments-session`
   * `payments-webhook`
   * `payments-reconcile`
   * `payments-test-checkout`
   * `refunds-process`

   `config.toml` sets `verify_jwt`. The webhook and the test page
   authenticate by signature; reconcile and refunds check the service-role
   bearer themselves.
4. Schedule, with the service-role bearer, both every 5 minutes:
   * `POST /functions/v1/payments-reconcile`, which reconciles payments,
     expires checkouts and bookings, refunds unaccepted orders, and
     completes delivered orders and past bookings;
   * `POST /functions/v1/refunds-process`.

## Everyday tasks (service role / SQL)

| Task | How |
|---|---|
| Ledger check for a community | `select * from public.ledger_summary('<community>');` The balances must sum to 0. |
| Retry a failed refund | `select public.refund_retry('<refund>');` (after fixing the cause) |
| Record a payout sent outside the app | `select public.payout_record('<community>', '<seller>', <minor>, 'bank_transfer', '<bank ref>', '<your name>', '<note>');` |
| Payment held for review (amount mismatch) | `select * from public.payments where failure_code = 'amount_mismatch';` Investigate with the provider; there is no automatic settlement. |

## Before live payments (checklist)

Each item is required.

- [ ] D2, D3: provider, merchant of record and legal or regulatory
      confirmation (Bank of Jamaica).
- [ ] A real provider adapter (`PaymentProvider`) with its webhook
      signature scheme, tested in the provider's sandbox.
- [ ] D4–D8 decided: commission, fees, refund and return policy, payouts
      and holds, seller verification.
- [ ] D9 GCT confirmed by an accountant. `tax_rates` reviewed.
- [ ] Scheduled jobs deployed and monitored. Alerts on failed refunds,
      mismatches and reconcile errors.
- [ ] An external security review and penetration test.
- [ ] Chargeback handling and a support process.

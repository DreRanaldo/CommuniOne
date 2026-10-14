// The TEST provider's hosted payment page (PAYMENTS_MODE=test only).
// See ../_shared/payments/handlers.ts (handleTestCheckout).
import { handleTestCheckout, handleWebhook } from '../_shared/payments/handlers.ts';
import { paymentsContext } from '../_shared/payments/env.ts';
import { TEST_SIGNATURE_HEADER } from '../_shared/payments/testProvider.ts';

const ctx = paymentsContext();
Deno.serve((req) =>
  handleTestCheckout(ctx, req, (body, signature) =>
    // Delivered in-process through the same verified webhook handler.
    handleWebhook(ctx, new Request('http://internal/payments-webhook', { method: 'POST', body, headers: { [TEST_SIGNATURE_HEADER]: signature } })),
  ).catch(() => new Response('internal error', { status: 500 })),
);

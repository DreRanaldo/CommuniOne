// See ../_shared/payments/handlers.ts (handleWebhook) and docs/commerce/payments.md.
import { handleWebhook } from '../_shared/payments/handlers.ts';
import { paymentsContext } from '../_shared/payments/env.ts';

const ctx = paymentsContext();
Deno.serve((req) => handleWebhook(ctx, req).catch(() => new Response('{"error":"internal error"}', { status: 500 })));

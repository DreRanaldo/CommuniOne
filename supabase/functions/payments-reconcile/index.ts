// See ../_shared/payments/handlers.ts (handleReconcile) and docs/commerce/payments.md.
import { handleReconcile } from '../_shared/payments/handlers.ts';
import { paymentsContext } from '../_shared/payments/env.ts';

const ctx = paymentsContext();
Deno.serve((req) => handleReconcile(ctx, req).catch(() => new Response('{"error":"internal error"}', { status: 500 })));

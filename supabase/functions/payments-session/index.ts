// See ../_shared/payments/handlers.ts (handleSession) and docs/commerce/payments.md.
import { handleSession } from '../_shared/payments/handlers.ts';
import { paymentsContext } from '../_shared/payments/env.ts';

const ctx = paymentsContext();
Deno.serve((req) => handleSession(ctx, req).catch(() => new Response('{"error":"internal error"}', { status: 500 })));

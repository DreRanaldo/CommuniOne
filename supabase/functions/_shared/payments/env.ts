// Builds the payments context from Edge Function secrets (Deno only).
// Required secrets (set with `supabase secrets set`, never committed):
//   PAYMENTS_MODE=test            the only mode implemented (no live provider yet)
//   PAYMENTS_TEST_SECRET          >= 32 random characters (test provider signing key)
//   PAYMENTS_RETURN_URL           app deep link, default communione://payment-return
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { assertSafeConfiguration } from './provider.ts';
import { createTestProvider } from './testProvider.ts';
import type { PaymentsContext, TestCheckoutProvider } from './handlers.ts';

declare const Deno: { env: { get(name: string): string | undefined } };

export function paymentsContext(): Omit<PaymentsContext, 'provider'> & { provider: TestCheckoutProvider } {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const mode = Deno.env.get('PAYMENTS_MODE') ?? 'test';
  if (mode !== 'test') {
    // No sandbox/live provider is implemented yet (decisions D2-D3).
    throw new Error(`PAYMENTS_MODE=${mode} is not available: no ${mode} payment provider is configured.`);
  }
  const provider = createTestProvider({
    secret: Deno.env.get('PAYMENTS_TEST_SECRET') ?? '',
    db,
    checkoutPageUrl: `${url}/functions/v1/payments-test-checkout`,
  });
  assertSafeConfiguration(provider, mode);
  const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    db,
    provider,
    serviceRoleKey,
    returnUrl: Deno.env.get('PAYMENTS_RETURN_URL') ?? 'communione://payment-return',
    async resolveUser(authorization) {
      const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!token) return null;
      const { data, error } = await auth.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
  };
}

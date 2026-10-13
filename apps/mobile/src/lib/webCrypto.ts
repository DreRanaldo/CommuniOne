// The two WebCrypto functions Supabase Auth needs for PKCE, backed by the
// platform's native crypto (expo-crypto):
//
//   crypto.getRandomValues  the code verifier. Without it, supabase-js falls
//                           back to Math.random(), which is predictable.
//   crypto.subtle.digest    the S256 code challenge (SHA-256 of the
//                           verifier). Without it, supabase-js sends the
//                           verifier itself as a "plain" challenge.
//
// React Native (Hermes) has neither. Installed once at startup (index.ts)
// before the Supabase client exists. Anything the runtime already provides
// is left untouched, and only SHA-256 is offered: this is not a general
// WebCrypto implementation.
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';

type Target = { crypto?: Partial<Crypto> & { subtle?: Partial<SubtleCrypto> } };

export function installWebCrypto(target: Target = globalThis as unknown as Target): void {
  const crypto = (target.crypto ??= {}) as Partial<Crypto> & { subtle?: Partial<SubtleCrypto> };
  if (typeof crypto.getRandomValues !== 'function') {
    crypto.getRandomValues = getRandomValues as Crypto['getRandomValues'];
  }
  if (typeof crypto.subtle?.digest !== 'function') {
    crypto.subtle = {
      ...(crypto.subtle as SubtleCrypto),
      digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() !== 'SHA-256') throw new Error(`Unsupported digest algorithm: ${name}`);
        return digest(CryptoDigestAlgorithm.SHA256, data);
      },
    } as SubtleCrypto;
  }
}

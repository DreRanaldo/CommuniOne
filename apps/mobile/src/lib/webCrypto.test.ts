// installWebCrypto() gives Supabase Auth a real S256 PKCE challenge and a
// cryptographically random verifier on React Native, where Hermes has no
// WebCrypto. Here expo-crypto's native module is backed by the test
// runtime's own WebCrypto, captured before any test removes it.
import { generatePKCEChallenge, generatePKCEVerifier } from '@supabase/auth-js/dist/main/lib/helpers';
import { installWebCrypto } from './webCrypto';

jest.mock('expo-crypto', () => {
  const real = globalThis.crypto;
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomValues: jest.fn((array: Uint8Array) => real.getRandomValues(array as Uint8Array<ArrayBuffer>)),
    digest: jest.fn((algorithm: string, data: BufferSource) => real.subtle.digest(algorithm, data)),
  };
});

const realCrypto = globalThis.crypto;
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const base64url = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('installWebCrypto', () => {
  test('a runtime without WebCrypto gets getRandomValues and SHA-256 digest', async () => {
    const target: { crypto?: Partial<Crypto> } = {};
    installWebCrypto(target);
    const bytes = target.crypto!.getRandomValues!(new Uint8Array(32));
    expect(bytes.some((b) => b !== 0)).toBe(true);
    const hash = await target.crypto!.subtle!.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(hex(hash)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await expect(target.crypto!.subtle!.digest('SHA-1', new Uint8Array())).rejects.toThrow(/Unsupported/);
  });

  test('what the runtime already provides is left alone', () => {
    const own = { getRandomValues: jest.fn(), subtle: { digest: jest.fn() } };
    const target = { crypto: own as unknown as Crypto };
    installWebCrypto(target);
    expect(target.crypto.getRandomValues).toBe(own.getRandomValues);
    expect(target.crypto.subtle.digest).toBe(own.subtle.digest);
  });

  test('Supabase Auth then uses S256 (not "plain") with a random verifier', async () => {
    // Simulate Hermes: no WebCrypto at all until installed.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      installWebCrypto();
      const verifier = generatePKCEVerifier();
      expect(verifier).toMatch(/^[0-9a-f]{56,112}$/); // hex of random values, not Math.random() characters
      const challenge = await generatePKCEChallenge(verifier);
      expect(challenge).not.toBe(verifier);
      const expected = await realCrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      expect(challenge).toBe(base64url(expected));
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/WebCrypto API is not supported/));
    } finally {
      warn.mockRestore();
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true });
    }
  });
});

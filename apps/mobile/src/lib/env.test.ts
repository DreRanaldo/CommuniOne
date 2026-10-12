import { fakeKey, jwtFor } from '@/testing/keys';
import { validateConfig } from './env';

const URL_OK = 'https://abcdefghij.supabase.co';
const ANON = jwtFor('anon');

describe('validateConfig', () => {
  test('accepts the hosted URL and the anon key', () => {
    expect(
      validateConfig({ EXPO_PUBLIC_SUPABASE_URL: `${URL_OK}/`, EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON }, false),
    ).toEqual({
      ok: true,
      config: { supabaseUrl: URL_OK, supabaseAnonKey: ANON },
    });
  });

  test('accepts a publishable key', () => {
    const result = validateConfig(
      { EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: fakeKey('publishable') },
      false,
    );
    expect(result.ok).toBe(true);
  });

  test('reports missing values', () => {
    const result = validateConfig({}, true);
    expect(result).toEqual({
      ok: false,
      problems: ['EXPO_PUBLIC_SUPABASE_URL is not set.', 'EXPO_PUBLIC_SUPABASE_ANON_KEY is not set.'],
    });
  });

  test('REFUSES the service-role key', () => {
    const result = validateConfig(
      { EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: jwtFor('service_role') },
      true,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.join(' ')).toMatch(/service-role key/);
  });

  test('REFUSES secret keys', () => {
    const result = validateConfig(
      { EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: fakeKey('secret') },
      true,
    );
    expect(!result.ok && result.problems.join(' ')).toMatch(/secret key/);
  });

  test('refuses keys for other roles and junk', () => {
    expect(
      validateConfig(
        { EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: jwtFor('authenticated') },
        true,
      ).ok,
    ).toBe(false);
    expect(
      validateConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'short' }, true).ok,
    ).toBe(false);
  });

  test('requires https except for a local server in development', () => {
    const local = { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON };
    expect(validateConfig(local, true).ok).toBe(true);
    expect(validateConfig(local, false).ok).toBe(false);
    expect(validateConfig({ ...local, EXPO_PUBLIC_SUPABASE_URL: 'http://evil.example' }, true).ok).toBe(
      false,
    );
    expect(validateConfig({ ...local, EXPO_PUBLIC_SUPABASE_URL: 'ftp://x.example' }, true).ok).toBe(false);
    expect(validateConfig({ ...local, EXPO_PUBLIC_SUPABASE_URL: 'not a url' }, true).ok).toBe(false);
  });

  test('problems never echo the configured values', () => {
    const secret = fakeKey('secret', 'DO_NOT_LEAK_123456');
    const result = validateConfig(
      { EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: secret },
      true,
    );
    expect(JSON.stringify(result)).not.toContain('DO_NOT_LEAK');
  });
});

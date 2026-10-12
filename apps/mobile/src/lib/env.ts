// Public runtime configuration, validated before anything uses it.
//
// Only EXPO_PUBLIC_* variables reach the app, and Expo inlines them into the
// bundle, so they must be safe to publish: the project URL and the anon /
// publishable key (which is subject to Row Level Security). The app refuses
// to start with anything that looks like a secret.

export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export type ConfigResult = { ok: true; config: PublicConfig } | { ok: false; problems: string[] };

export interface RawEnv {
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/;

function decodeJwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Validates the public configuration.
 * @param isDevelopment plain http is accepted only for local hosts in development builds.
 */
export function validateConfig(env: RawEnv, isDevelopment: boolean): ConfigResult {
  const problems: string[] = [];
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';

  let parsed: URL | null = null;
  if (!url) {
    problems.push('EXPO_PUBLIC_SUPABASE_URL is not set.');
  } else {
    try {
      parsed = new URL(url);
    } catch {
      problems.push('EXPO_PUBLIC_SUPABASE_URL is not a valid URL.');
    }
  }
  if (parsed) {
    const local = LOCAL_HOSTS.test(parsed.hostname);
    if (parsed.protocol === 'http:' && !(isDevelopment && local)) {
      problems.push(
        'EXPO_PUBLIC_SUPABASE_URL must use https:// (plain http only for a local server in development).',
      );
    } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      problems.push('EXPO_PUBLIC_SUPABASE_URL must be an http(s) URL.');
    }
  }

  if (!key) {
    problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY is not set.');
  } else if (key.startsWith('sb_secret_')) {
    problems.push(
      'EXPO_PUBLIC_SUPABASE_ANON_KEY is a secret key. Use the anon / publishable key; secret keys must never ship in the app.',
    );
  } else {
    const role = decodeJwtRole(key);
    if (role === 'service_role') {
      problems.push(
        'EXPO_PUBLIC_SUPABASE_ANON_KEY is the service-role key. It bypasses Row Level Security and must never ship in the app.',
      );
    } else if (role !== null && role !== 'anon') {
      problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY must be the anon key.');
    } else if (role === null && !key.startsWith('sb_publishable_') && key.length < 20) {
      problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY does not look like a Supabase anon or publishable key.');
    }
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, config: { supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: key } };
}

/**
 * Reads the inlined public variables. They must be referenced literally
 * (for example process.env.EXPO_PUBLIC_SUPABASE_URL) for Expo to inline them.
 */
export function readConfig(): ConfigResult {
  return validateConfig(
    {
      EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    },
    __DEV__,
  );
}

/**
 * A JWT-shaped key with the given role claim, assembled at runtime so no
 * key-like literal exists in the repository (the secret scan stays strict).
 */
export function jwtFor(role: string): string {
  const payload = btoa(JSON.stringify({ role, iss: 'supabase' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return ['header', payload, 'signature'].join('.');
}

/** A fake new-style Supabase key (`sb_publishable_…` / `sb_secret_…`), also assembled at runtime. */
export function fakeKey(kind: 'publishable' | 'secret', body = 'abcdefghijklmnop'): string {
  return ['sb', kind, body].join('_');
}

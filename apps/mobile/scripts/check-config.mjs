// Verifies the resolved Expo config for every build variant:
//   - it resolves (the production build configuration is valid);
//   - names, ids and the deep-link scheme are what each variant expects;
//   - it contains nothing secret (it is embedded in the app binary);
//   - app code only reads the two allowed public environment variables.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];
const fail = (message) => failures.push(message);

const SECRET_PATTERNS = [
  /sb_secret_/i,
  /service[_-]?role/i,
  /password/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
];

const expected = {
  development: { name: 'CommuniOne (development)', id: 'com.communione.app.development' },
  preview: { name: 'CommuniOne (preview)', id: 'com.communione.app.preview' },
  production: { name: 'CommuniOne', id: 'com.communione.app' },
};

for (const [variant, want] of Object.entries(expected)) {
  const json = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
    cwd: root,
    env: { ...process.env, APP_VARIANT: variant, EXPO_OFFLINE: '1' },
    encoding: 'utf8',
  });
  const config = JSON.parse(json);
  if (config.name !== want.name) fail(`${variant}: name is "${config.name}", expected "${want.name}"`);
  if (config.ios?.bundleIdentifier !== want.id)
    fail(`${variant}: iOS bundle id is "${config.ios?.bundleIdentifier}"`);
  if (config.android?.package !== want.id)
    fail(`${variant}: Android package is "${config.android?.package}"`);
  if (config.scheme !== 'communione') fail(`${variant}: scheme is "${config.scheme}"`);
  if (JSON.stringify(Object.keys(config.extra ?? {})) !== JSON.stringify(['appVariant'])) {
    fail(
      `${variant}: extra must contain only appVariant, found ${Object.keys(config.extra ?? {}).join(', ')}`,
    );
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(json)) fail(`${variant}: public config matches ${pattern}`);
  }
  console.log(`config ok: ${variant} (${config.name}, ${want.id})`);
}

// App code may read only these environment variables (Expo inlines them).
const ALLOWED_ENV = new Set(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
for (const file of walk(path.join(root, 'src'))) {
  if (
    !/\.(ts|tsx)$/.test(file) ||
    /\.test\.tsx?$/.test(file) ||
    file.includes(`${path.sep}testing${path.sep}`)
  )
    continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    if (!ALLOWED_ENV.has(match[1])) fail(`${path.relative(root, file)} reads process.env.${match[1]}`);
  }
  // src/lib/env.ts is the guard that rejects such keys, so it names them.
  const isGuard = path.relative(root, file) === path.join('src', 'lib', 'env.ts');
  if (!isGuard && /SERVICE_ROLE|sb_secret_/i.test(source)) {
    fail(`${path.relative(root, file)} mentions a server-only secret`);
  }
}

if (failures.length > 0) {
  console.error(`\nConfig check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('config check passed');

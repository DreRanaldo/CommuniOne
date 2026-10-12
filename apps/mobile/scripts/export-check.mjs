// Production build check without a device or native toolchain:
// bundles the app for Android and iOS exactly as a release build would
// (APP_VARIANT=production, minified, Hermes bytecode), then inspects the
// output:
//   - the public Supabase values were inlined (the build is configured);
//   - a server-only variable present at build time is NOT in the bundle;
//   - no service-role / secret key material is in the bundle.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = mkdtempSync(path.join(tmpdir(), 'communione-export-'));

// Placeholders only: not real credentials.
const PUBLIC_URL = 'https://ci-placeholder.supabase.co';
const PUBLIC_KEY = ['sb', 'publishable', 'ci_placeholder_key_0123456789'].join('_');
const SERVER_ONLY_CANARY = 'server-only-canary-must-not-be-bundled-7f3a9c';

try {
  execFileSync('npx', ['expo', 'export', '--platform', 'android', '--platform', 'ios', '--output-dir', out], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_VARIANT: 'production',
      NODE_ENV: 'production',
      EXPO_OFFLINE: '1',
      EXPO_PUBLIC_SUPABASE_URL: PUBLIC_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: PUBLIC_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVER_ONLY_CANARY,
    },
  });

  const files = (function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  })(out);
  const bundles = files.filter((f) => /\.(hbc|js)$/.test(f) && f.includes(`${path.sep}_expo${path.sep}`));
  const failures = [];
  for (const platform of ['android', 'ios']) {
    if (!bundles.some((f) => f.includes(`${path.sep}${platform}${path.sep}`)))
      failures.push(`no ${platform} bundle produced`);
  }
  const contents = bundles.map((f) => readFileSync(f).toString('latin1')).join('\n');
  if (!contents.includes(PUBLIC_URL) || !contents.includes(PUBLIC_KEY)) {
    failures.push('public Supabase configuration was not inlined');
  }
  if (contents.includes(SERVER_ONLY_CANARY)) failures.push('a server-only environment variable was bundled');
  if (/sb_secret_[A-Za-z0-9]/.test(contents)) failures.push('a secret key is present in the bundle');

  if (failures.length > 0) {
    console.error(`\nExport check failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    const size = bundles.reduce((sum, f) => sum + statSync(f).size, 0);
    console.log(`\nexport check passed: ${bundles.length} bundles, ${(size / 1024 / 1024).toFixed(1)} MiB`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

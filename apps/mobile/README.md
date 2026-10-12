# CommuniOne mobile app

Expo (SDK 57) + React Native + TypeScript. Architecture and decisions:
[`docs/architecture/mobile-app.md`](../../docs/architecture/mobile-app.md).

## Setup

```bash
cd apps/mobile
npm ci
cp .env.example .env.local      # then fill in the two PUBLIC values
```

`.env.local` needs only:

| Variable                        | Value                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | Local: `http://127.0.0.1:54321` (from `npx supabase status` at the repo root; on an Android emulator use `http://10.0.2.2:54321`). Hosted: `https://<ref>.supabase.co`. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The **anon / publishable** key.                                                                                                                                         |

Never use the service-role key, a database password or any other secret here:
`EXPO_PUBLIC_*` values are compiled into the app. The app shows a configuration
error and refuses to start if the key is a service-role or secret key, or if a
non-local URL is not `https://`.

## Run

```bash
npm start            # scan the QR code with Expo Go, or press a / i
```

All native modules used are included in Expo Go, so no custom development build
is needed yet.

## Verify

```bash
npm run lint          # ESLint (eslint-config-expo) — zero warnings allowed
npm run format:check  # Prettier
npm run typecheck     # tsc (also type-checks the shared ../../services)
npm test              # Jest (jest-expo) + React Native Testing Library
npm run config:check  # Expo config for every variant: ids, scheme, no secrets
npm run export:check  # production Android + iOS bundles; inlining and secret checks
npm run doctor        # expo-doctor (needs network)
npm run verify        # everything above except doctor
```

## Build variants

`APP_VARIANT` = `development` (default) | `preview` | `production` selects the
app name and bundle id (`com.communione.app[.development|.preview]`). EAS sets it
per profile in `eas.json`:

```bash
npx eas-cli@latest build --profile preview      # internal testing build
npx eas-cli@latest build --profile production   # store build
```

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` for each EAS
environment with `eas env:create` (they are public values, but keep them out of
git so each environment can differ). Before the first store build, confirm the
bundle identifiers and replace the placeholder icons in `assets/`.

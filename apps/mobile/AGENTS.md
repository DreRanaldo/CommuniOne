# CommuniOne mobile app: notes for coding agents

Read the repository rules in `../../Claude.md` and the architecture in
`../../docs/architecture/mobile-app.md` before changing anything here.

## Expo changes every SDK: do not trust memory

This app uses **Expo SDK 57** (React Native 0.86, React 19.2). Check APIs against
the versioned docs (`https://docs.expo.dev/versions/v57.0.0/`) or the installed
package's own types/README. Add native packages with `npx expo install <pkg>`
(SDK-compatible versions), never plain `npm install`.

## Architecture rules

- **Navigation is React Navigation** (native stack + bottom tabs) configured in
  `src/navigation/`. This project does **not** use Expo Router; do not add an
  `app/` routes folder.
- **Backend access goes through the shared service layer** (`../../services`,
  imported as `@communione/services`) via `useServices()`. Do not call
  `supabase.from(...)` / `.rpc(...)` from screens, and do not create a second
  service layer in this app.
- **Styles come from `src/theme`** (`useTheme`, `makeStyles`) and components from
  `src/components`. No hard-coded colours, font sizes or spacing in screens.
- **Only public configuration** (`EXPO_PUBLIC_SUPABASE_URL`,
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never add the service-role key, a database
  password or any secret; `npm run config:check` and the app itself refuse them.
- Never log with `console.*` (lint error); use `src/lib/logger.ts` (redacted).

## Commands

```bash
npm start              # Expo dev server (Expo Go works: no custom native modules)
npm run verify         # lint, format check, typecheck, tests, config check, production export
npm run doctor         # expo-doctor (needs network)
```

`ios/` and `android/` are generated (Continuous Native Generation); configure
native behaviour in `app.config.ts`, never by editing generated folders.

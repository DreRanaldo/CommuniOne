# Mobile App Foundation (RN-01)

The CommuniOne mobile app lives in [`apps/mobile`](../../apps/mobile): Expo SDK 57,
React Native 0.86, React 19.2, TypeScript (strict). This stage builds the
foundation only: project setup, navigation skeleton, design system, safe
Supabase integration, tooling, tests and CI. Feature screens come in later stages.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Location | `apps/mobile`, its own `package.json` and lockfile | Keeps the large React Native dependency tree out of the backend/database CI jobs. The admin web app can sit beside it later (`apps/admin`). |
| Backend access | The shared service layer at the repo root (`services/`), imported as `@communione/services` | One implementation of validation, error mapping and pagination for both apps. No second service layer in the app. Metro (`watchFolders`), Jest (`roots`) and TypeScript (`paths`) resolve it; it has no runtime dependencies of its own. |
| Navigation | React Navigation 7 (native stack + bottom tabs), configured in `src/navigation/` | Explicit, typed navigators make the auth gate structural (signed-out users only *have* the auth branch) and match the requested `navigation/` + `screens/` structure. Expo Router (file-based, also built on React Navigation) was considered; it would replace `navigation/` with an `app/` routes folder. It can be adopted later without changing screens. |
| Session storage | Keychain / Keystore via `expo-secure-store`, chunked (`src/lib/secureStorage.ts`) | Access and refresh tokens are encrypted at rest, never synced to other devices (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). Chunking handles SecureStore's ~2 KB value limit. Unlike AsyncStorage, nothing is stored in plain text. |
| Configuration | `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` only, validated at start (`src/lib/env.ts`) | These are the only values a public client may hold. A service-role or `sb_secret_` key, a missing value, or a non-local `http://` URL shows a configuration-error screen; no client is created. |
| Variants | `app.config.ts` with `APP_VARIANT` = development / preview / production; EAS profiles in `eas.json` | Separate names and bundle ids per variant, so test builds never overwrite the store app. |
| State / data loading | React context + a small `useAsync` hook | No state or query library yet; add one (e.g. TanStack Query) when feature screens need caching, with a documented decision. |
| Fonts and icons | System fonts; Ionicons from `@expo/vector-icons` | No font downloads; one consistent icon family. |
| Images (RN-03) | `expo-image-picker` + `expo-image-manipulator` behind a `MediaPicker` dependency | Expo's own modules for the photo library and resizing; a 512 px JPEG keeps uploads small and drops EXIF. Injected, so tests use a fake. |
| Tests | Jest (`jest-expo`) + React Native Testing Library 14 | The Expo-supported setup; RNTL 14 matches React 19 (async render). |
| Lint / format | ESLint 9 with `eslint-config-expo` (flat config) + Prettier | Expo's recommended rules, including the React Compiler-era hooks rules; Prettier owns formatting. |

## Structure

```
apps/mobile/
  index.ts                 registerRootComponent(App)
  app.config.ts            public Expo config per variant (no secrets)
  eas.json                 preview / production build profiles
  metro.config.js          Expo defaults + the shared ../../services
  src/
    App.tsx                validates config → creates the client → providers → navigation
    AppProviders.tsx       safe area, theme, dependencies, auth, navigation container
    components/            design-system primitives: Text, Button, TextField, Card,
                           Icon, Screen, LoadingState, ErrorState, EmptyState
    theme/                 tokens (colours light/dark, type, spacing, radius), ThemeProvider,
                           useTheme, makeStyles
    navigation/            RootNavigator, AuthNavigator, AppTabs, CommunityNavigator,
                           CommunityNavigator (Home tab), linking (deep links), shared options
    features/<domain>/     domain screens, components and hooks:
                           announcements, auth, comments, communities, feed, home, notifications,
                           profile, reactions
    screens/               app-shell screens not owned by a domain:
                           PlaceholderScreen, ConfigErrorScreen
    hooks/                 useAsync (+ re-exports of useServices, useAuth)
    lib/                   env (validation), supabase (client), secureStorage,
                           dependencies (context), media (photo picker), logger
    types/                 navigation param lists
    utils/                 error presentation (ServiceError → message / field)
    constants/             app name, URL scheme
    testing/               test helpers (fake Supabase, renderers, fake keys); not bundled
  scripts/                 check-config.mjs, export-check.mjs
```

There is no `src/services/`: the service layer is the repository's `services/`.

## Navigation

```
RootStack
├── (signed out)  Auth ── Welcome · SignIn · SignUp · ForgotPassword
├── (recovery)    ResetPassword            ← communione://auth/reset-password?code=…
└── (signed in)   App (tabs) ── Home · Communities · Discover · Market · Profile  (+ a floating Create button above the bar)
                  │   Home and Communities = the current community, one stack each, starting at
                  │          Feed (Home, with stories) or CommunityHome (Communities); every stack has
                  │          PostDetail · PostEditor · Announcements · Alerts · Events (+ details, editors) · Documents · DocumentDetail · DocumentUpload · Members · MemberProfile · CommunitySettings · EditCommunity
                  │          (or "Your communities" when none is selected)
                  │   Discover = your communities, join with a code, start a community
                  │   floating + (Home, Communities, Discover main screens) = opens the Create sheet
                  │   Market = placeholder (a later module)
                  │   Profile ── ProfileHome · EditProfile · Account · ChangePassword · DeleteAccount
                  Communities (modal, the switcher)  ← communione://communities[/<communityId>]
                  Notifications (the center, from the feed's bell)  ← communione://notifications
                  NotificationDetail  ← communione://notifications/<notificationId>
                  Create (modal: the floating +; actions from permissions)
                  StoryComposer (modal) · StoryViewer (full screen)
                  CreateCommunity (modal)
                  JoinCommunity (modal: code → preview → join)  ← communione://join?token=…
```

- **Auth gate:** `RootNavigator` renders only the branch for the current auth
  state (`restoring` shows a loading state). Signing in or out swaps the whole
  tree, so no authenticated screen stays mounted without a session. This is UX
  only; the database authorizes every request.
- **Community scope (RN-04):** the current community lives in
  `CurrentCommunityProvider` (app level). Screens read it with `useCommunity()`;
  no route carries a community id. The selection is always one of the user's own
  memberships as returned by the server. Access is still decided by RLS. See
  [`community-selection.md`](community-selection.md).
- **Deep links:** scheme `communione`; `join?token=…` opens the Join modal. The
  token is treated like a password: never displayed or logged.
  `communities/<id>` asks to switch community and is validated first.
- **Typed routes:** every navigator has a param list in `src/types/navigation.ts`.

Built now: Welcome, Sign in, Sign up, Forgot password, Reset password
(authentication: see [`mobile-authentication.md`](mobile-authentication.md)),
the community selector (RN-04: see [`community-selection.md`](community-selection.md)),
the community home (RN-06: see [`../features/community-home.md`](../features/community-home.md)),
the feed (RN-07: see [`../features/feed.md`](../features/feed.md)),
comments, reactions and moderation (RN-08: see [`../features/comments-and-reactions.md`](../features/comments-and-reactions.md)),
announcements (RN-09: see [`../features/announcements-app.md`](../features/announcements-app.md)),
alerts (RN-10: see [`../features/alerts-app.md`](../features/alerts-app.md)),
events and RSVPs (RN-11: see [`../features/events-app.md`](../features/events-app.md)),
the notification center (RN-12: see [`../features/notifications-app.md`](../features/notifications-app.md)),
community documents (RN-13: see [`../features/documents-app.md`](../features/documents-app.md)),
community settings (RN-15: see [`../features/community-settings.md`](../features/community-settings.md)),
the admin tools and feed timeline (RN-16: see [`../features/mobile-admin.md`](../features/mobile-admin.md)),
quick alerts with location and photo (see [`../features/quick-alerts.md`](../features/quick-alerts.md)),
the member directory (RN-14: see [`../features/members-app.md`](../features/members-app.md)),
the design pass with stories (see [`../features/design-pass.md`](../features/design-pass.md) and [`../features/stories.md`](../features/stories.md)),
creating and joining communities (RN-05: see [`../features/create-and-join.md`](../features/create-and-join.md)), and
the profile and account screens (RN-03: see [`../features/profile.md`](../features/profile.md)).
Placeholder: Market (a later module).

## Design system

- **White, photo-first redesign:** pure white surfaces, near-black text, light-gray hairlines and the logo blue as the one accent. Light is the app's appearance; the dark tokens are kept for later. See [`../features/feed-images.md`](../features/feed-images.md).
- **Brand** (from the CommuniOne logo, `apps/mobile/assets/brand/`):
  - **Colours.** The logo's blue `#0069CE` is the primary colour (5.4:1 with
    white text), its navy `#162B46` is the body text colour, and success text
    uses a darker green `#06753F`. The logo's bright green, teal and orange are
    decorative only (`brand` in `tokens.ts`): the green is 2.7:1 on white, too
    low for text. `src/theme/contrast.test.ts` checks primary, text, muted,
    success and severity colours against WCAG AA in both themes.
  - **`BrandLogo`** (`src/components`): the mark above the wordmark, or the
    mark alone. It is one image named "CommuniOne" for screen readers. In dark
    mode the mark sits on a white tile (its inner disc is white in the logo)
    and the wordmark's navy letters become white. Used on Welcome (with the
    tagline "One platform. Every community.") and on Sign in and Sign up.
  - **App icon, splash and Android adaptive icons** are generated from the
    logo by `apps/mobile/scripts/brand-assets.py` (Pillow; a development-time
    tool, not run in CI). The splash background is white in light mode; the
    adaptive icon background is white.

- **Tokens** (`src/theme/tokens.ts`): a light and a dark palette (calm neutrals,
  one confident blue for actions, a severity scale for alerts whose colours all
  meet WCAG AA as text, checked by `src/theme/contrast.test.ts`), a 4-point
  spacing scale, radii, a 7-step type scale on system fonts, and a 48 pt minimum
  touch target.
- **Usage:** components read tokens through `useTheme()`; screens style with
  `makeStyles((theme) => …)`. Screens contain no literal colours, font sizes or
  spacing values.
- **Components:** `Text` (variants and tones), `Button` (primary, secondary,
  ghost, danger; loading and disabled states), `TextField` (label, hint, error),
  `Card` (optionally pressable), `Icon`, `Screen` (safe areas, keyboard, scroll),
  `LoadingState`, `ErrorState` (retry), `EmptyState` (action).
- **Accessibility:** roles, labels, busy/disabled states, live regions for
  errors, labelled inputs; tests query by role and label.
- **Light/dark:** follows the system setting (`userInterfaceStyle: automatic`).

## Supabase integration and security

- One client per app run, created from validated config with the anon /
  publishable key: `persistSession`, `autoRefreshToken`, keychain storage,
  `detectSessionInUrl: false`, PKCE email links (RN-02). Creating it makes no
  network request.
- Token refresh runs only in the foreground (`AppState`), as Supabase recommends
  for React Native.
- Screens use `useServices()` (the shared service layer); the raw client is used
  only for auth state. The service-role key never exists in the app:
  - the app refuses to start with one;
  - `npm run config:check` fails if app code reads any environment variable
    other than the two public ones, or if the public Expo config contains
    anything secret-looking;
  - `npm run export:check` builds production bundles with a server-only
    variable set and fails if it appears in the bundle;
  - the repository secret scan covers the app.
- Logs go through the service layer's redacting logger (`console.*` is a lint
  error); release builds log nothing yet.

## Verification

| Check | Command | What it proves |
|---|---|---|
| Lint | `npm run lint` | ESLint (Expo rules), zero warnings |
| Format | `npm run format:check` | Prettier |
| Types | `npm run typecheck` | Strict TS (`noUncheckedIndexedAccess`) for the app and the shared services |
| Tests | `npm test` | 520 tests: quick alerts (13, see `../features/quick-alerts.md`), admin tools (33, see `../features/mobile-admin.md`), feed timeline (4 rules), floating Create button (4), media file reading (2), posting fixes (2), community settings (16, see `../features/community-settings.md`), member directory (12, see `../features/members-app.md`), design pass (11) and stories (13 + 3 rules, see `../features/stories.md`), documents (24 + 5 rules + 4 upload transport, see `../features/documents-app.md`), notification center (24 + 13 rules, see `../features/notifications-app.md`), feed redesign and photo posts (17, see `../features/feed-images.md`), PKCE WebCrypto (3), brand logo (1) and colour contrast (12, brand and severity), events and RSVPs (22 + 6 rules), alerts (22 + 5 rules), announcements (17 + 5 rules), comments, reactions and moderation (24), feed (23), community home (16), create and join (21 + 9 rules), community selection (25 + 15 rules), profile and account (29, see `../features/profile.md`), authentication flows (23, see `mobile-authentication.md`), app launch (valid config / service-role key / missing config), navigation (restoring, signed-out gate, sign-in errors, sign-in → tabs → community → section, Join modal, sign-out, error + retry, deep links), design system, secure storage, Supabase client safety, config validation, error presentation, `useAsync` |
| Config | `npm run config:check` | Every variant's Expo config resolves with the right name, ids and scheme, and holds no secrets |
| Production build | `npm run export:check` | Release bundles for Android and iOS build (Hermes); public values inlined; server-only values and secret keys absent |
| Health | `npm run doctor` | expo-doctor (SDK compatibility; needs network) |

All of these run in CI (job "Mobile app", see [`../development/ci.md`](../development/ci.md)).

## Known limitations

- No device or simulator in CI: "launch" is verified by rendering the full app
  tree in Jest and by building production bundles, not by booting a binary.
  Native builds run on EAS.
- The app icon and splash come from a 1254 px logo image; ask for a vector
  (SVG) or larger master before store submission. The bundle ids
  (`com.communione.app`) are placeholders: confirm them before the first store build.
- Push notifications and member management (approve, suspend, roles) are not built in the app yet. Creating invitations (sharing a code or QR) is not in the app yet.
- No offline cache or query library yet.

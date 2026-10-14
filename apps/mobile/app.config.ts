// Expo app configuration (replaces app.json so values can depend on the build
// variant). Only public, non-secret values belong here: everything in this
// file ends up inside the app binary and `expo config --type public`.
//
// APP_VARIANT selects the variant: development | preview | production.
// EAS sets it per build profile (eas.json); locally it defaults to development.
import type { ConfigContext, ExpoConfig } from 'expo/config';

type Variant = 'development' | 'preview' | 'production';

const VARIANTS: Variant[] = ['development', 'preview', 'production'];
const requested = process.env.APP_VARIANT ?? 'development';
if (!VARIANTS.includes(requested as Variant)) {
  throw new Error(`APP_VARIANT must be one of ${VARIANTS.join(', ')} (got "${requested}")`);
}
const variant = requested as Variant;

// Placeholder identifiers: confirm the final reverse-domain ids before the
// first store submission (they cannot change after release).
const BASE_ID = 'com.communione.app';
const suffix = variant === 'production' ? '' : `.${variant}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === 'production' ? 'CommuniOne' : `CommuniOne (${variant})`,
  slug: 'communione',
  version: '0.1.0',
  scheme: 'communione',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: `${BASE_ID}${suffix}`,
    supportsTablet: true,
  },
  android: {
    package: `${BASE_ID}${suffix}`,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-secure-store',
    [
      'expo-image-picker',
      {
        photosPermission:
          'CommuniOne uses your photo library only when you choose a picture to share (profile, posts, alerts).',
        cameraPermission: 'CommuniOne uses the camera only when you take a photo to add to an alert.',
        microphonePermission: false,
      },
    ],
    [
      'expo-location',
      {
        // Foreground only, read once when you choose to share your location on an alert.
        locationWhenInUsePermission:
          'CommuniOne reads your location only when you choose to share it on an alert, so neighbours know where to look.',
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#FFFFFF',
      },
    ],
  ],
  extra: {
    appVariant: variant,
  },
});

import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProviders } from '@/AppProviders';
import { createDependencies } from '@/lib/dependencies';
import { readConfig, type ConfigResult } from '@/lib/env';
import { createSupabaseClient } from '@/lib/supabase';
import { createXhrUploader } from '@/lib/uploader';
import { linking, RootNavigator } from '@/navigation';
import { ConfigErrorScreen } from '@/screens/ConfigErrorScreen';
import { ThemeProvider } from '@/theme';

// Keep the native splash screen until the stored session is restored (RootNavigator hides it).
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App({ config = readConfig() }: { config?: ConfigResult }) {
  // One Supabase client for the app's lifetime, created only from a validated config.
  const dependencies = useMemo(() => {
    if (!config.ok) return null;
    const client = createSupabaseClient(config.config);
    return createDependencies(client, undefined, undefined, createXhrUploader(config.config, client));
  }, [config]);

  useEffect(() => {
    if (!config.ok) SplashScreen.hideAsync().catch(() => {});
  }, [config.ok]);

  if (!config.ok || !dependencies) {
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <ConfigErrorScreen problems={config.ok ? [] : config.problems} />
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <AppProviders dependencies={dependencies} linking={linking}>
      <RootNavigator />
    </AppProviders>
  );
}

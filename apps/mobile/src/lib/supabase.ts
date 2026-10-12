// The app's single Supabase client: the PUBLIC anon / publishable key plus the
// signed-in user's session. Every request it makes is subject to Row Level
// Security. The service-role key never exists in this app.
import 'react-native-url-polyfill/auto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';
import type { Database } from '@communione/services';
import type { PublicConfig } from './env';
import { secureStorage } from './secureStorage';

export type AppSupabaseClient = SupabaseClient<Database>;

/** Creates the client. Creating it makes no network request. */
export function createSupabaseClient(config: PublicConfig): AppSupabaseClient {
  return createClient<Database>(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storage: secureStorage,
      persistSession: true,
      autoRefreshToken: true,
      // No browser URL to read sessions from in a native app; deep links are handled explicitly.
      detectSessionInUrl: false,
    },
  });
}

/**
 * Refresh tokens only while the app is in the foreground (Supabase's
 * recommendation for React Native). Returns an unsubscribe function.
 */
export function manageAutoRefresh(client: AppSupabaseClient): () => void {
  const apply = (state: AppStateStatus) => {
    if (state === 'active') void client.auth.startAutoRefresh();
    else void client.auth.stopAutoRefresh();
  };
  apply(AppState.currentState);
  const subscription = AppState.addEventListener('change', apply);
  return () => subscription.remove();
}

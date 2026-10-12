import { NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { CurrentCommunityProvider } from '@/features/communities/CurrentCommunityProvider';
import { DependenciesProvider, type Dependencies } from '@/lib/dependencies';
import { navigationTheme } from '@/navigation/options';
import { ThemeProvider, useTheme } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';

function ThemedNavigation({
  children,
  linking,
}: {
  children: ReactNode;
  linking?: LinkingOptions<RootStackParamList>;
}) {
  const theme = useTheme();
  return (
    <NavigationContainer theme={navigationTheme(theme)} linking={linking}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </NavigationContainer>
  );
}

/** The current community belongs to the signed-in user (none while signed out or in recovery). */
function SignedInCommunity({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const userId = auth.status === 'signedIn' && !auth.recovery ? (auth.session?.user.id ?? null) : null;
  return <CurrentCommunityProvider userId={userId}>{children}</CurrentCommunityProvider>;
}

/** Everything the screens need, in one place (also used by tests with fake dependencies). */
export function AppProviders({
  dependencies,
  children,
  linking,
  scheme,
}: {
  dependencies: Dependencies;
  children: ReactNode;
  linking?: LinkingOptions<RootStackParamList>;
  scheme?: 'light' | 'dark';
}) {
  return (
    <SafeAreaProvider>
      <ThemeProvider scheme={scheme}>
        <DependenciesProvider value={dependencies}>
          <AuthProvider>
            <SignedInCommunity>
              <ThemedNavigation linking={linking}>{children}</ThemedNavigation>
            </SignedInCommunity>
          </AuthProvider>
        </DependenciesProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

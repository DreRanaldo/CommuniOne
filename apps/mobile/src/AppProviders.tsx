import { NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/features/auth/AuthProvider';
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
            <ThemedNavigation linking={linking}>{children}</ThemedNavigation>
          </AuthProvider>
        </DependenciesProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { LoadingState } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { ResetPasswordScreen } from '@/features/auth/screens/ResetPasswordScreen';
import { JoinCommunityScreen } from '@/features/communities/screens/JoinCommunityScreen';
import type { RootStackParamList } from '@/types/navigation';
import { AppTabs } from './AppTabs';
import { AuthNavigator } from './AuthNavigator';
import { CommunityNavigator } from './CommunityNavigator';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Signed-out users only have the Auth branch; signed-in users only have the
 * App branches (or, after a password-reset link, only the reset screen).
 * Switching session swaps the whole tree, so no authenticated screen can be
 * reached, or stay mounted, without a session. This is UX only: the database
 * enforces access on every request.
 */
export function RootNavigator() {
  const auth = useAuth();
  const screenOptions = useStackOptions();
  const ready = auth.status !== 'restoring';

  // Keep the native splash screen up until the stored session has been read.
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return <LoadingState label="Starting CommuniOne…" />;
  if (auth.completingLink) return <LoadingState label="Opening your link…" />;

  return (
    <Stack.Navigator screenOptions={{ ...screenOptions, headerShown: false }}>
      {auth.status === 'signedOut' ? (
        <Stack.Screen name="Auth" component={AuthNavigator} />
      ) : auth.recovery ? (
        <Stack.Screen
          name="ResetPassword"
          component={ResetPasswordScreen}
          options={{ headerShown: true, title: 'Choose a new password' }}
        />
      ) : (
        <>
          <Stack.Screen name="App" component={AppTabs} />
          <Stack.Screen name="Community" component={CommunityNavigator} />
          <Stack.Screen
            name="JoinCommunity"
            component={JoinCommunityScreen}
            options={{ presentation: 'modal', headerShown: true, title: 'Join a community' }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}

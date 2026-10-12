import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoadingState } from '@/components';
import { JoinCommunityScreen } from '@/features/communities/screens/JoinCommunityScreen';
import { useAuth } from '@/features/auth/AuthProvider';
import type { RootStackParamList } from '@/types/navigation';
import { AppTabs } from './AppTabs';
import { AuthNavigator } from './AuthNavigator';
import { CommunityNavigator } from './CommunityNavigator';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Signed-out users only have the Auth branch; signed-in users only have the
 * App branches. Switching session swaps the whole tree, so no authenticated
 * screen can be reached (or stay mounted) without a session. This is UX
 * only: the database enforces access on every request.
 */
export function RootNavigator() {
  const auth = useAuth();
  const screenOptions = useStackOptions();

  if (auth.status === 'restoring') return <LoadingState label="Starting CommuniOne…" />;

  return (
    <Stack.Navigator screenOptions={{ ...screenOptions, headerShown: false }}>
      {auth.status === 'signedOut' ? (
        <Stack.Screen name="Auth" component={AuthNavigator} />
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

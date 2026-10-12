import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AccountScreen } from '@/features/profile/screens/AccountScreen';
import { ChangePasswordScreen } from '@/features/profile/screens/ChangePasswordScreen';
import { DeleteAccountScreen } from '@/features/profile/screens/DeleteAccountScreen';
import { EditProfileScreen } from '@/features/profile/screens/EditProfileScreen';
import { ProfileScreen } from '@/features/profile/screens/ProfileScreen';
import type { ProfileStackParamList } from '@/types/navigation';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<ProfileStackParamList>();

/** The signed-in user's own profile and account. Every screen acts on the session's user only. */
export function ProfileNavigator() {
  const screenOptions = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="ProfileHome" component={ProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'Edit profile' }} />
      <Stack.Screen name="Account" component={AccountScreen} options={{ title: 'Account & security' }} />
      <Stack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ title: 'Change password' }}
      />
      <Stack.Screen
        name="DeleteAccount"
        component={DeleteAccountScreen}
        options={{ title: 'Delete account' }}
      />
    </Stack.Navigator>
  );
}

import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@/features/auth/AuthProvider';
import { ForgotPasswordScreen } from '@/features/auth/screens/ForgotPasswordScreen';
import { SignInScreen } from '@/features/auth/screens/SignInScreen';
import { SignUpScreen } from '@/features/auth/screens/SignUpScreen';
import { WelcomeScreen } from '@/features/auth/screens/WelcomeScreen';
import type { AuthStackParamList } from '@/types/navigation';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator() {
  const screenOptions = useStackOptions();
  const { notice } = useAuth();
  // After an expired session, go straight to sign-in (where the notice is shown).
  const initialRouteName = notice?.kind === 'sessionExpired' ? 'SignIn' : 'Welcome';
  return (
    <Stack.Navigator screenOptions={screenOptions} initialRouteName={initialRouteName}>
      <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SignIn" component={SignInScreen} options={{ title: 'Sign in' }} />
      <Stack.Screen name="SignUp" component={SignUpScreen} options={{ title: 'Create account' }} />
      <Stack.Screen
        name="ForgotPassword"
        component={ForgotPasswordScreen}
        options={{ title: 'Reset password' }}
      />
    </Stack.Navigator>
  );
}

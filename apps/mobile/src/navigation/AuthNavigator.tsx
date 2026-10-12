import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SignInScreen } from '@/features/auth/screens/SignInScreen';
import { SignUpScreen } from '@/features/auth/screens/SignUpScreen';
import { WelcomeScreen } from '@/features/auth/screens/WelcomeScreen';
import type { AuthStackParamList } from '@/types/navigation';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator() {
  const screenOptions = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SignIn" component={SignInScreen} options={{ title: 'Sign in' }} />
      <Stack.Screen name="SignUp" component={SignUpScreen} options={{ title: 'Create account' }} />
    </Stack.Navigator>
  );
}

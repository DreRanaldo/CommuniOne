import { EmptyState, Screen } from '@/components';

/** Account creation (services.auth.signUp) is built in the authentication-screens stage. */
export function SignUpScreen() {
  return (
    <Screen scroll={false} testID="sign-up-screen">
      <EmptyState
        icon="person-add-outline"
        title="Create an account"
        message="Account creation arrives with the authentication screens in the next stage."
      />
    </Screen>
  );
}

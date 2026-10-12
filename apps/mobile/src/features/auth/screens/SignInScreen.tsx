import { useState } from 'react';
import { Button, Screen, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { errorField, errorMessage } from '@/utils/errors';

/**
 * Email + password sign-in through services.auth (validation, one message for
 * every credential failure, rate-limit aware). On success Supabase emits a
 * SIGNED_IN event and the root navigator switches to the app.
 */
export function SignInScreen() {
  const { auth } = useServices();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await auth.signIn({ email, password });
    } catch (thrown) {
      setError({ message: errorMessage(thrown), field: errorField(thrown) });
      setSubmitting(false);
    }
  };

  return (
    <Screen testID="sign-in-screen">
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={error?.field === 'email' ? error.message : null}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={error?.field === 'password' ? error.message : null}
        onSubmitEditing={submit}
      />
      {error && !error.field ? (
        <Text tone="danger" accessibilityRole="alert">
          {error.message}
        </Text>
      ) : null}
      <Button title="Sign in" onPress={submit} loading={submitting} disabled={!email || !password} />
    </Screen>
  );
}

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Banner, Button, EmptyState, Screen, Text, TextField } from '@/components';
import { PASSWORD_RESET_URL } from '@/constants/app';
import { useServices } from '@/lib/dependencies';
import type { AuthStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { emailError } from '../validation';

/**
 * Requests a password-reset email. The confirmation is identical whether or
 * not the address has an account; only connection problems and rate limits
 * are reported, so a request that never left the phone is not shown as sent.
 */
export function ForgotPasswordScreen({
  navigation,
}: NativeStackScreenProps<AuthStackParamList, 'ForgotPassword'>) {
  const { auth } = useServices();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const error = emailError(email);
    setFieldError(error);
    setFormError(null);
    if (error) return;
    setSubmitting(true);
    try {
      await auth.requestPasswordReset({ email, redirectTo: PASSWORD_RESET_URL });
      setSent(true);
    } catch (thrown) {
      setFormError(errorMessage(thrown));
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <Screen scroll={false} testID="forgot-password-sent">
        <EmptyState
          icon="mail-outline"
          title="Check your email"
          message="If an account exists for that address, we have sent a link to choose a new password. Open it on this phone."
          action={{ title: 'Back to sign in', onPress: () => navigation.navigate('SignIn') }}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="forgot-password-screen">
      <Text tone="muted">Enter your email address and we will send you a link to choose a new password.</Text>
      {formError ? <Banner tone="danger" message={formError} testID="forgot-password-error" /> : null}
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={fieldError}
        onSubmitEditing={submit}
      />
      <Button title="Send reset link" onPress={submit} loading={submitting} />
    </Screen>
  );
}

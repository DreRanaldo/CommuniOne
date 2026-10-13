import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Banner, BrandLogo, Button, EmptyState, Screen, Text, TextField } from '@/components';
import { AUTH_CALLBACK_URL } from '@/constants/app';
import { useServices } from '@/lib/dependencies';
import type { AuthStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import { confirmError, emailError, hasErrors, newPasswordError, type FieldErrors } from '../validation';

type Field = 'displayName' | 'email' | 'password' | 'confirm';

/**
 * Account creation through services.auth.signUp. The confirmation email links
 * back into the app (communione://auth/callback), which signs the user in.
 * The result is the same whether or not the address already has an account.
 */
export function SignUpScreen({ navigation }: NativeStackScreenProps<AuthStackParamList, 'SignUp'>) {
  const { auth } = useServices();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async () => {
    const errors: FieldErrors<Field> = {
      displayName: displayName.trim().length > 100 ? 'Use at most 100 characters.' : undefined,
      email: emailError(email),
      password: newPasswordError(password),
      confirm: confirmError(password, confirm),
    };
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    try {
      await auth.signUp({
        email,
        password,
        displayName: displayName.trim() || undefined,
        emailRedirectTo: AUTH_CALLBACK_URL,
      });
      setPassword('');
      setConfirm('');
      setSentTo(email.trim());
    } catch (error) {
      const field = errorField(error);
      if (field === 'email' || field === 'password' || field === 'displayName') {
        setFieldErrors({ [field]: errorMessage(error) });
      } else {
        setFormError(errorMessage(error));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (sentTo) {
    return (
      <Screen scroll={false} testID="sign-up-sent">
        <EmptyState
          icon="mail-unread-outline"
          title="Check your email"
          message={`We sent a confirmation link to ${sentTo}. Open it on this phone to finish creating your account.`}
          action={{ title: 'Back to sign in', onPress: () => navigation.navigate('SignIn') }}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="sign-up-screen">
      <BrandLogo variant="mark" size={56} />
      <Text tone="muted">
        Create your CommuniOne account. You can join communities once you are signed in.
      </Text>
      {formError ? <Banner tone="danger" message={formError} testID="sign-up-error" /> : null}
      <TextField
        label="Name (optional)"
        value={displayName}
        onChangeText={setDisplayName}
        autoComplete="name"
        textContentType="name"
        error={fieldErrors.displayName}
      />
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={fieldErrors.email}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        hint="At least 8 characters, with letters and numbers."
        error={fieldErrors.password}
      />
      <TextField
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={fieldErrors.confirm}
        onSubmitEditing={submit}
      />
      <Button title="Create account" onPress={submit} loading={submitting} />
      <Button
        title="I already have an account"
        variant="ghost"
        onPress={() => navigation.navigate('SignIn')}
      />
    </Screen>
  );
}

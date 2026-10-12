import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Screen, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { AuthStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import { AuthNoticeBanner } from '../components/AuthNoticeBanner';
import { emailError, hasErrors, type FieldErrors } from '../validation';

type Field = 'email' | 'password';

/**
 * Email + password sign-in through services.auth. One message covers wrong
 * passwords, unknown addresses and unconfirmed addresses, so the screen never
 * reveals whether an account exists. On success Supabase emits SIGNED_IN and
 * the root navigator swaps to the app.
 */
export function SignInScreen({ navigation }: NativeStackScreenProps<AuthStackParamList, 'SignIn'>) {
  const styles = useStyles();
  const { auth } = useServices();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const errors: FieldErrors<Field> = {
      email: emailError(email),
      password: password ? undefined : 'Enter your password.',
    };
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    try {
      await auth.signIn({ email, password });
      // The navigator replaces this screen; the password is not kept anywhere.
    } catch (error) {
      const field = errorField(error);
      if (field === 'email' || field === 'password') setFieldErrors({ [field]: errorMessage(error) });
      else setFormError(errorMessage(error));
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <Screen testID="sign-in-screen">
      <AuthNoticeBanner />
      {formError ? <Banner tone="danger" message={formError} testID="sign-in-error" /> : null}
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
        autoComplete="current-password"
        textContentType="password"
        error={fieldErrors.password}
        onSubmitEditing={submit}
      />
      <Button title="Sign in" onPress={submit} loading={submitting} />
      <View style={styles.links}>
        <Button
          title="Forgot password?"
          variant="ghost"
          onPress={() => navigation.navigate('ForgotPassword')}
        />
        <Button title="Create an account" variant="ghost" onPress={() => navigation.navigate('SignUp')} />
      </View>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  links: { gap: t.spacing.xs },
}));

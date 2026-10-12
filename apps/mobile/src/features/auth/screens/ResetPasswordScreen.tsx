import { useState } from 'react';
import { Banner, Button, Screen, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { errorField, errorMessage } from '@/utils/errors';
import { useAuth } from '../AuthProvider';
import { confirmError, hasErrors, newPasswordError, type FieldErrors } from '../validation';

type Field = 'password' | 'confirm';

/**
 * Shown after a password-reset link signs the user in (recovery mode): the
 * user must choose a new password before reaching the app, or cancel (which
 * signs out).
 */
export function ResetPasswordScreen() {
  const { auth: authService } = useServices();
  const auth = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const errors: FieldErrors<Field> = {
      password: newPasswordError(password),
      confirm: confirmError(password, confirm),
    };
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    try {
      await authService.updatePassword(password);
      setPassword('');
      setConfirm('');
      auth.finishRecovery();
    } catch (error) {
      if (errorField(error) === 'password') setFieldErrors({ password: errorMessage(error) });
      else setFormError(errorMessage(error));
      setSubmitting(false);
    }
  };

  return (
    <Screen testID="reset-password-screen">
      <Text tone="muted">Choose a new password for your account.</Text>
      {formError ? <Banner tone="danger" message={formError} testID="reset-password-error" /> : null}
      <TextField
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        hint="At least 8 characters, with letters and numbers."
        error={fieldErrors.password}
      />
      <TextField
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={fieldErrors.confirm}
        onSubmitEditing={submit}
      />
      <Button title="Save new password" onPress={submit} loading={submitting} />
      <Button
        title="Cancel and sign out"
        variant="ghost"
        onPress={() => void auth.signOut()}
        disabled={submitting}
      />
    </Screen>
  );
}

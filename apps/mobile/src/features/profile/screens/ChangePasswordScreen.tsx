import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Banner, Button, Screen, Text, TextField } from '@/components';
import { confirmError, hasErrors, newPasswordError, type FieldErrors } from '@/features/auth/validation';
import { useServices } from '@/lib/dependencies';
import type { ProfileStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';

type Field = 'currentPassword' | 'newPassword' | 'confirm';

/**
 * Changes the password through services.auth.changePassword, which re-checks
 * the current password with Supabase Auth first. Passwords live only in this
 * screen's state and are cleared after every attempt that reaches the server.
 */
export function ChangePasswordScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParamList, 'ChangePassword'>) {
  const { auth } = useServices();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const errors: FieldErrors<Field> = {
      currentPassword: currentPassword ? undefined : 'Enter your current password.',
      newPassword:
        newPasswordError(newPassword) ??
        (newPassword && newPassword === currentPassword ? 'Choose a different password.' : undefined),
      confirm: confirmError(newPassword, confirm),
    };
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    try {
      await auth.changePassword({ currentPassword, newPassword });
      navigation.popTo('Account', { passwordChanged: true });
    } catch (error) {
      const field = errorField(error);
      if (field === 'currentPassword' || field === 'newPassword')
        setFieldErrors({ [field]: errorMessage(error) });
      else setFormError(errorMessage(error));
      setCurrentPassword('');
      setSubmitting(false);
    }
  };

  return (
    <Screen testID="change-password-screen">
      <Text tone="muted">For your security, enter your current password first.</Text>
      {formError ? <Banner tone="danger" message={formError} testID="change-password-error" /> : null}
      <TextField
        label="Current password"
        value={currentPassword}
        onChangeText={setCurrentPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={fieldErrors.currentPassword}
      />
      <TextField
        label="New password"
        value={newPassword}
        onChangeText={setNewPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        hint="At least 8 characters, with letters and numbers."
        error={fieldErrors.newPassword}
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
      <Button title="Change password" onPress={submit} loading={submitting} />
    </Screen>
  );
}

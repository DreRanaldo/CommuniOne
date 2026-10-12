import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { ProfileStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';

/** Account information from Auth, password, sign-out and account deletion. */
export function AccountScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProfileStackParamList, 'Account'>) {
  const styles = useStyles();
  const { auth: authService } = useServices();
  const auth = useAuth();
  const load = useCallback(() => authService.getMyAccount(), [authService]);
  const account = useAsync(load);
  const [busy, setBusy] = useState<'local' | 'global' | null>(null);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async (scope: 'local' | 'global') => {
    setBusy(scope);
    setError(null);
    try {
      // The navigator replaces the app with the signed-out screens.
      await (scope === 'global' ? auth.signOutEverywhere() : auth.signOut());
    } catch (thrown) {
      setError(errorMessage(thrown));
      setBusy(null);
    }
  };

  if (account.status === 'loading') return <LoadingState label="Loading your account…" />;
  if (account.status === 'error') {
    return (
      <ErrorState
        title="Your account could not be loaded"
        message={errorMessage(account.error)}
        onRetry={account.reload}
      />
    );
  }
  const info = account.data;

  return (
    <Screen testID="account-screen">
      {route.params?.passwordChanged ? (
        <Banner tone="success" message="Your password has been changed." testID="password-changed" />
      ) : null}
      <Card testID="account-info">
        <Row label="Email" value={info.email ?? '—'} />
        <Row
          label="Email confirmed"
          value={info.emailConfirmedAt ? formatDate(info.emailConfirmedAt) : 'Not yet'}
        />
        <Row label="Member since" value={formatDate(info.createdAt)} />
        <Row label="Last sign-in" value={formatDate(info.lastSignInAt)} />
        {info.status !== 'active' ? (
          <Text variant="caption" tone="danger">
            Your account is {info.status}. Some actions are unavailable.
          </Text>
        ) : null}
      </Card>

      <Text variant="heading">Security</Text>
      <Button
        title="Change password"
        variant="secondary"
        icon="key-outline"
        onPress={() => navigation.navigate('ChangePassword')}
        disabled={busy !== null}
      />

      <Text variant="heading">Sign out</Text>
      {error ? <Banner tone="danger" message={error} testID="account-error" /> : null}
      <Button
        title="Sign out"
        variant="secondary"
        icon="log-out-outline"
        onPress={() => signOut('local')}
        loading={busy === 'local'}
        disabled={busy !== null}
      />
      {confirmEverywhere ? (
        <Card testID="confirm-sign-out-everywhere">
          <Text>Sign out on every device, including this one? Each device will need to sign in again.</Text>
          <View style={styles.row}>
            <Button
              title="Sign out everywhere"
              variant="danger"
              fullWidth={false}
              onPress={() => signOut('global')}
              loading={busy === 'global'}
              disabled={busy !== null}
            />
            <Button
              title="Keep me signed in"
              variant="ghost"
              fullWidth={false}
              onPress={() => setConfirmEverywhere(false)}
            />
          </View>
        </Card>
      ) : (
        <Button
          title="Sign out of all devices"
          variant="ghost"
          onPress={() => setConfirmEverywhere(true)}
          disabled={busy !== null}
        />
      )}

      <Text variant="heading">Delete account</Text>
      <Text tone="muted">Permanently delete your account and personal information.</Text>
      <Button
        title="Delete account…"
        variant="danger"
        icon="trash-outline"
        onPress={() => navigation.navigate('DeleteAccount')}
        disabled={busy !== null}
      />
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.info} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <Text>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  info: { gap: t.spacing.xxs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
}));

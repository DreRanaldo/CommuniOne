import { useState } from 'react';
import { Button, Card, Screen, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useServices } from '@/lib/dependencies';
import { errorMessage } from '@/utils/errors';

export function ProfileScreen() {
  const auth = useAuth();
  const { auth: authService } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await authService.signOut('local');
    } catch (thrown) {
      setError(errorMessage(thrown));
      setBusy(false);
    }
  };

  return (
    <Screen testID="profile-screen">
      <Card>
        <Text variant="caption" tone="muted">
          Signed in as
        </Text>
        <Text variant="bodyStrong">{auth.session?.user.email ?? ''}</Text>
      </Card>
      {error ? <Text tone="danger">{error}</Text> : null}
      <Button title="Sign out" variant="secondary" icon="log-out-outline" onPress={signOut} loading={busy} />
    </Screen>
  );
}

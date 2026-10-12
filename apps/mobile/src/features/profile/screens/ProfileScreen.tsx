import { useState } from 'react';
import { Banner, Button, Card, Screen, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { errorMessage } from '@/utils/errors';

export function ProfileScreen() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.signOut();
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
      {error ? <Banner tone="danger" message={error} /> : null}
      <Button title="Sign out" variant="secondary" icon="log-out-outline" onPress={signOut} loading={busy} />
    </Screen>
  );
}

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError } from '@communione/services';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Screen, Text, TextField } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { makeStyles } from '@/theme';
import type { ProfileStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';

const CONFIRMATION = 'DELETE';

const DELETED = [
  'Your sign-in, profile, photo and phone number',
  'Your community memberships and roles',
  'Your reactions, RSVPs and notifications',
];
const KEPT = [
  'Posts, comments and other community content you created, shown as "Deleted User"',
  'Communities you created',
  'Security records (audit log), which never contain your name or contact details',
];

/**
 * Deletes the signed-in user's account through the backend function
 * delete_my_account() (services.auth.deleteMyAccount). The app never deletes
 * records itself: the function takes no user id, deletes only the session
 * user, and refuses if that would leave a community without anyone able to
 * manage it. After it succeeds the app signs out locally.
 */
export function DeleteAccountScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParamList, 'DeleteAccount'>) {
  const styles = useStyles();
  const auth = useAuth();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<{ title?: string; message: string } | null>(null);
  const confirmed = typed.trim().toUpperCase() === CONFIRMATION;

  const remove = async () => {
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      await auth.deleteAccount();
      // Signed out: the navigator shows the signed-out screens with a notice.
    } catch (thrown) {
      setError(
        isServiceError(thrown) && thrown.code === ErrorCode.Conflict
          ? { title: 'Transfer your communities first', message: errorMessage(thrown) }
          : { message: errorMessage(thrown) },
      );
      setDeleting(false);
    }
  };

  return (
    <Screen testID="delete-account-screen">
      <Text variant="title">Delete your account?</Text>
      <Text>This cannot be undone.</Text>
      <Card>
        <Text variant="bodyStrong">Deleted permanently</Text>
        {DELETED.map((item) => (
          <Bullet key={item} text={item} />
        ))}
      </Card>
      <Card>
        <Text variant="bodyStrong">Kept for your communities</Text>
        {KEPT.map((item) => (
          <Bullet key={item} text={item} />
        ))}
      </Card>
      <Text tone="muted">
        If you are the only person who can manage a community that still has other members, give another
        member the Owner role first.
      </Text>
      {error ? (
        <Banner tone="danger" title={error.title} message={error.message} testID="delete-account-error" />
      ) : null}
      <TextField
        label={`Type ${CONFIRMATION} to confirm`}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!deleting}
      />
      <View style={styles.actions}>
        <Button
          title="Delete my account"
          variant="danger"
          icon="trash-outline"
          onPress={remove}
          loading={deleting}
          disabled={!confirmed}
        />
        <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={deleting} />
      </View>
    </Screen>
  );
}

function Bullet({ text }: { text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.bullet}>
      <Text>•</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  actions: { gap: t.spacing.sm },
  bullet: { flexDirection: 'row', gap: t.spacing.sm },
  bulletText: { flex: 1 },
}));

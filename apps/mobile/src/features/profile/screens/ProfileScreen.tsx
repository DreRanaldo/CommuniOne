import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { Avatar, Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { makeStyles } from '@/theme';
import type { ProfileStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { displayNameOf, useMyProfile } from '../hooks/useMyProfile';

/**
 * The signed-in user's own profile. The phone number is shown only here (and
 * in the edit form): the backend returns it to its owner and to nobody else.
 */
export function ProfileScreen({ navigation }: NativeStackScreenProps<ProfileStackParamList, 'ProfileHome'>) {
  const styles = useStyles();
  const me = useMyProfile({ reloadOnFocus: true });

  if (me.status === 'loading') return <LoadingState label="Loading your profile…" />;
  if (me.status === 'error') {
    return (
      <ErrorState
        title="Your profile could not be loaded"
        message={errorMessage(me.error)}
        onRetry={me.reload}
      />
    );
  }

  const { profile, phone, avatarUri } = me.data;
  const name = displayNameOf(profile);
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');

  return (
    <Screen testID="profile-screen">
      <View style={styles.header}>
        <Avatar uri={avatarUri} name={name} size={96} />
        <Text variant="title" align="center">
          {name ?? 'Add your name'}
        </Text>
        {fullName && fullName !== name ? (
          <Text tone="muted" align="center">
            {fullName}
          </Text>
        ) : null}
      </View>

      <Card>
        <Text variant="label" tone="muted">
          About
        </Text>
        <Text tone={profile.bio ? 'default' : 'muted'}>{profile.bio ?? 'No bio yet.'}</Text>
      </Card>

      <Card testID="profile-phone">
        <Text variant="label" tone="muted">
          Phone number
        </Text>
        <Text tone={phone ? 'default' : 'muted'}>{phone ?? 'Not added'}</Text>
        <View style={styles.private}>
          <Icon name="lock-closed-outline" size={16} color="textMuted" />
          <Text variant="caption" tone="muted">
            Private: only you can see your phone number.
          </Text>
        </View>
      </Card>

      <Button title="Edit profile" icon="create-outline" onPress={() => navigation.navigate('EditProfile')} />
      <Button
        title="Account & security"
        variant="secondary"
        icon="shield-checkmark-outline"
        onPress={() => navigation.navigate('Account')}
      />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  header: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
  private: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
}));

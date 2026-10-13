import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useRef } from 'react';
import { View } from 'react-native';
import { Avatar, Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { roleLabel } from '@/features/communities/selection';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { brand, makeStyles } from '@/theme';
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
  const { auth } = useServices();
  const { current } = useCurrentCommunity();
  const loadStats = useCallback(() => auth.getMyStats(), [auth]);
  const stats = useAsync(loadStats);
  // Back from editing or elsewhere: fresh counts.
  const { reload: reloadStats } = stats;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else reloadStats();
    }, [reloadStats]),
  );

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
  const counts = stats.status === 'success' ? stats.data : null;
  const subtitle = [current ? roleLabel(current) : null, current?.name].filter(Boolean).join(' · ');

  return (
    <Screen testID="profile-screen" edges={['top', 'left', 'right']}>
      <View style={styles.card}>
        <View style={styles.cover}>
          <View style={[styles.blob, styles.blobTeal]} />
          <View style={[styles.blob, styles.blobGreen]} />
        </View>
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Avatar uri={avatarUri} name={name} size={96} />
          </View>
          <View style={styles.names}>
            <Text variant="title">{name ?? 'Add your name'}</Text>
            {fullName && fullName !== name ? <Text tone="muted">{fullName}</Text> : null}
            {subtitle ? (
              <Text variant="caption" tone="muted" testID="profile-subtitle">
                {subtitle}
              </Text>
            ) : null}
            {counts?.member_since ? (
              <View style={styles.row}>
                <Icon name="calendar-outline" size={14} color="textMuted" />
                <Text variant="caption" tone="muted" testID="profile-joined">
                  {`Joined ${new Date(counts.member_since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={styles.padded}>
          <Button
            title="Edit profile"
            variant="secondary"
            icon="settings-outline"
            onPress={() => navigation.navigate('EditProfile')}
          />
          <Text tone={profile.bio ? 'default' : 'muted'} testID="profile-bio">
            {profile.bio ?? 'No bio yet.'}
          </Text>
        </View>
        {counts ? (
          <View style={styles.stats} testID="profile-stats">
            {[
              { label: 'Posts', value: counts.posts },
              { label: 'Events joined', value: counts.events_going },
              { label: 'Communities', value: counts.communities },
            ].map((stat, i) => (
              <View
                key={stat.label}
                style={[styles.stat, i > 0 && styles.statDivider]}
                accessible
                accessibilityLabel={`${stat.value} ${stat.label}`}
              >
                <Text variant="title">{stat.value.toLocaleString()}</Text>
                <Text variant="caption" tone="muted">
                  {stat.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <Card testID="profile-phone">
        <Text variant="label" tone="muted">
          Phone number
        </Text>
        <Text tone={phone ? 'default' : 'muted'}>{phone ?? 'Not added'}</Text>
        <View style={styles.row}>
          <Icon name="lock-closed-outline" size={16} color="textMuted" />
          <Text variant="caption" tone="muted">
            Private: only you can see your phone number.
          </Text>
        </View>
      </Card>

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
  card: {
    borderRadius: t.radius.lg + 8,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
    backgroundColor: t.colors.surface,
  },
  cover: { height: 110, backgroundColor: t.colors.primary, overflow: 'hidden' },
  blob: { position: 'absolute', width: 180, height: 180, borderRadius: 90, opacity: 0.55 },
  blobTeal: { right: -30, top: -60, backgroundColor: brand.teal },
  blobGreen: { right: 90, top: 30, backgroundColor: brand.green, opacity: 0.35 },
  identity: { flexDirection: 'row', gap: t.spacing.md, paddingHorizontal: t.spacing.lg, marginTop: -40 },
  avatar: { borderRadius: 52, borderWidth: 4, borderColor: t.colors.surface, alignSelf: 'flex-start' },
  names: { flex: 1, paddingTop: 44, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  padded: { padding: t.spacing.lg, gap: t.spacing.md },
  stats: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: t.colors.border },
  stat: { flex: 1, alignItems: 'center', paddingVertical: t.spacing.md, gap: 2 },
  statDivider: { borderLeftWidth: 1, borderLeftColor: t.colors.border },
}));

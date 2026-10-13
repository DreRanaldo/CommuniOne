import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError } from '@communione/services';
import { useCallback } from 'react';
import { View } from 'react-native';
import { Avatar, Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { joinedLine, memberName } from '../memberRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'MemberProfile'>;

/**
 * A member's community profile in the current community: picture, names,
 * roles (when visible), when they joined and their bio. The server returns
 * only these fields, and only for active members of this community; phone
 * numbers and e-mail addresses are never sent to the app.
 */
export function MemberProfileScreen({ route, navigation }: Props) {
  const styles = useStyles();
  const { userId } = route.params;
  const { memberships } = useServices();
  const community = useCommunity();
  const load = useCallback(
    () => memberships.member(community.community_id, userId),
    [memberships, community.community_id, userId],
  );
  const member = useAsync(load);

  if (member.status === 'loading') return <LoadingState label="Loading the profile…" />;
  if (member.status === 'error') {
    const gone =
      isServiceError(member.error) &&
      [ErrorCode.NotFound, ErrorCode.Forbidden].includes(member.error.code as never);
    return (
      <ErrorState
        title={gone ? 'This member is not available' : 'The profile could not be loaded'}
        message={gone ? `They may have left ${community.name}.` : errorMessage(member.error)}
        onRetry={gone ? undefined : member.reload}
      />
    );
  }

  const m = member.data;
  const name = memberName(m);
  const fullName = [m.firstName, m.lastName].filter(Boolean).join(' ');
  const joined = joinedLine(m.joinedAt);
  return (
    <Screen testID="member-profile-screen">
      <View style={styles.header}>
        <Avatar uri={m.avatarUrl} name={name} size={96} />
        <Text variant="title" align="center" testID="member-name">
          {name}
        </Text>
        {fullName && fullName !== name ? (
          <Text tone="muted" align="center">
            {fullName}
          </Text>
        ) : null}
        {m.roles && m.roles.length > 0 ? (
          <View style={styles.roles} testID="member-roles">
            {m.roles.map((role) => (
              <View key={role} style={styles.role}>
                <Text variant="caption" tone="primary">
                  {role}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text variant="caption" tone="muted">
          {[community.name, joined].filter(Boolean).join(' · ')}
        </Text>
      </View>

      <Card testID="member-bio">
        <Text variant="label" tone="muted">
          About
        </Text>
        <Text tone={m.bio ? 'default' : 'muted'}>{m.bio ?? 'No bio yet.'}</Text>
      </Card>

      <View style={styles.privacy}>
        <Icon name="lock-closed-outline" size={16} color="textMuted" />
        <Text variant="caption" tone="muted" style={styles.flex}>
          Phone numbers and e-mail addresses are private and never shown to other members.
        </Text>
      </View>

      {m.isMe ? (
        <Button
          title="Edit your profile"
          variant="secondary"
          icon="create-outline"
          onPress={() =>
            navigation.getParent()?.navigate('Profile', { screen: 'EditProfile', initial: false })
          }
        />
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  header: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md },
  roles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.spacing.xs },
  role: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 2,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.primarySoft,
  },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
}));

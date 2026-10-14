import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Member, Role } from '@communione/services';
import { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  Text,
} from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { memberName } from '@/features/members/memberRules';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';
import {
  ACTION_DONE,
  ACTION_LABELS,
  CONFIRM,
  canManageMembers,
  memberActionError,
  memberActions,
  roleError,
  type MemberAction,
} from '../adminRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AdminMember'>;

const STATUS_LABELS: Record<string, string> = {
  active: 'Active member',
  pending: 'Asked to join',
  suspended: 'Suspended',
  rejected: 'Request declined',
  left: 'Left the community',
};

type Notice = { tone: 'danger' | 'success'; message: string };

/**
 * One membership, for people who manage members (RN-16). The membership is
 * read from the server and must belong to the current community; the actions
 * shown follow its status and the user's permissions, never yourself. The
 * database authorizes each action (permission + the "cover" rule: nobody
 * acts on someone holding permissions they lack).
 */
export function AdminMemberScreen({ navigation, route }: Props) {
  const community = useCommunity();
  const { memberships, roles } = useServices();
  const permissions = useCommunityPermissions();
  const { membershipId } = route.params;

  const load = useCallback(async (): Promise<Member | null> => {
    const member = await memberships.get(membershipId);
    // Defence in depth: never act on another community's membership from this one.
    return member.communityId === community.community_id ? member : null;
  }, [memberships, membershipId, community.community_id]);
  const loaded = useAsync(load);
  const canAssign = permissions.can('roles.manage');
  const loadRoles = useCallback(
    async (): Promise<Role[]> => (canAssign ? roles.list(community.community_id) : []),
    [roles, community.community_id, canAssign],
  );
  const roleList = useAsync(loadRoles);

  if (!canManageMembers(permissions.can)) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Not available"
        message="You don't have permission to manage members here."
      />
    );
  }
  if (loaded.status === 'loading') return <LoadingState label="Loading member…" />;
  if (loaded.status === 'error' || loaded.data === null) {
    return (
      <ErrorState
        title="This member could not be loaded"
        message={
          loaded.status === 'error'
            ? memberActionError(loaded.error)
            : 'This member is not in this community.'
        }
        onRetry={loaded.status === 'error' ? loaded.reload : undefined}
      />
    );
  }
  return (
    <MemberDetail
      key={loaded.data.id}
      initial={loaded.data}
      roles={roleList.status === 'success' ? roleList.data : null}
      rolesError={roleList.status === 'error' ? roleList.error : null}
      onRemoved={() => navigation.goBack()}
    />
  );
}

function MemberDetail({
  initial,
  roles,
  rolesError,
  onRemoved,
}: {
  initial: Member;
  roles: Role[] | null;
  rolesError: unknown;
  onRemoved(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const { session } = useAuth();
  const services = useServices();
  const permissions = useCommunityPermissions();
  const [member, setMember] = useState(initial);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<MemberAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const name = memberName(member);
  const isMe = member.userId === session?.user.id;
  const actions = memberActions({ status: member.status, isMe }, permissions.can);
  const held = new Set(member.roles.map((r) => r.id));
  const canAssign = permissions.can('roles.manage') && !isMe && member.status === 'active';

  const run = async (action: MemberAction) => {
    setBusy(action);
    setNotice(null);
    try {
      const { memberships } = services;
      if (action === 'remove') {
        await memberships.remove(member.id);
        onRemoved();
        return;
      }
      const updated = await memberships[action](member.id);
      setMember(updated);
      setNotice({ tone: 'success', message: ACTION_DONE[action] });
    } catch (thrown) {
      setNotice({ tone: 'danger', message: memberActionError(thrown) });
    } finally {
      setConfirming(null);
      setBusy(null);
    }
  };

  const toggleRole = async (role: Role, give: boolean) => {
    setBusy(`role-${role.id}`);
    setNotice(null);
    try {
      if (give) await services.roles.assign(member.id, role.id);
      else await services.roles.unassign(member.id, role.id);
      setMember(await services.memberships.get(member.id));
      setNotice({
        tone: 'success',
        message: give
          ? `${name} now has the ${role.name} role.`
          : `${name} no longer has the ${role.name} role.`,
      });
    } catch (thrown) {
      setNotice({ tone: 'danger', message: roleError(thrown) });
    } finally {
      setBusy(null);
    }
  };

  const question = confirming ? CONFIRM[confirming] : undefined;

  return (
    <Screen testID="admin-member-screen">
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'danger' ? 'admin-member-error' : 'admin-member-done'}
        />
      ) : null}
      <View style={styles.head}>
        <Avatar uri={member.avatarUrl} name={name} size={64} label="" />
        <View style={styles.flex}>
          <Text variant="title">{isMe ? `${name} (you)` : name}</Text>
          <Text tone="muted" testID="admin-member-status">
            {[
              STATUS_LABELS[member.status] ?? member.status,
              member.joinedAt ? `Joined ${formatDate(member.joinedAt)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      </View>

      {isMe ? (
        <Text tone="muted">
          Nobody can change their own membership or roles. Leave from Community settings.
        </Text>
      ) : null}

      {actions.length > 0 ? (
        <Card testID="admin-member-actions">
          {confirming && question ? (
            <View style={styles.confirm}>
              <Text>{question(name, community.name)}</Text>
              <View style={styles.row}>
                <Button
                  title={ACTION_LABELS[confirming]}
                  variant="danger"
                  fullWidth={false}
                  loading={busy === confirming}
                  onPress={() => void run(confirming)}
                />
                <Button
                  title="Keep"
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy !== null}
                  onPress={() => setConfirming(null)}
                />
              </View>
            </View>
          ) : (
            actions.map((action) => (
              <Button
                key={action}
                title={ACTION_LABELS[action]}
                variant={action === 'approve' || action === 'reinstate' ? 'primary' : 'secondary'}
                loading={busy === action}
                disabled={busy !== null}
                onPress={() => (CONFIRM[action] ? setConfirming(action) : void run(action))}
              />
            ))
          )}
        </Card>
      ) : null}

      <Text variant="heading" accessibilityRole="header">
        Roles
      </Text>
      <Card testID="admin-member-roles">
        {canAssign && roles ? (
          roles.map((role, i) => (
            <View key={role.id} style={[styles.roleRow, i > 0 && styles.divider]}>
              <View style={styles.flex}>
                <Text variant="bodyStrong">{role.name}</Text>
                {role.description ? (
                  <Text variant="caption" tone="muted">
                    {role.description}
                  </Text>
                ) : null}
              </View>
              <Switch
                value={held.has(role.id)}
                disabled={busy !== null}
                onValueChange={(give) => void toggleRole(role, give)}
                accessibilityLabel={`${role.name} role`}
                trackColor={{ true: colors.primary, false: colors.border }}
                testID={`role-${role.name}`}
              />
            </View>
          ))
        ) : (
          <Text testID="admin-member-role-names">
            {member.roles.length > 0 ? member.roles.map((r) => r.name).join(' · ') : 'No roles'}
          </Text>
        )}
        {canAssign && rolesError ? <Text tone="danger">{errorMessage(rolesError)}</Text> : null}
        {canAssign ? (
          <Text variant="caption" tone="muted">
            You can give or take only roles whose permissions you hold yourself.
          </Text>
        ) : null}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  head: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  flex: { flex: 1, gap: 2 },
  confirm: { gap: t.spacing.sm },
  row: { flexDirection: 'row', gap: t.spacing.sm, flexWrap: 'wrap' },
  roleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, paddingVertical: t.spacing.sm },
  divider: { borderTopWidth: 1, borderTopColor: t.colors.border },
}));

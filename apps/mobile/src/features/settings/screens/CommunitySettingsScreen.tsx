import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type CommunityNotificationSettings } from '@communione/services';
import { useCallback, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Banner, Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCommunity, useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { roleLabel } from '@/features/communities/selection';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { hasAdminTools } from '@/features/admin/adminRules';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';

type Props = NativeStackScreenProps<CommunityStackParamList, 'CommunitySettings'>;

const KINDS: { key: keyof CommunityNotificationSettings; title: string; detail: string }[] = [
  { key: 'announcements', title: 'Announcements', detail: 'Official news from the community' },
  {
    key: 'events',
    title: 'New events',
    detail: 'When an event is published. Changes to events you replied to always reach you.',
  },
  { key: 'comments', title: 'Replies to you', detail: 'Comments on your posts and replies to your comments' },
  {
    key: 'alerts',
    title: 'Info and warning alerts',
    detail: 'Urgent and emergency alerts always reach you.',
  },
];

/**
 * Settings for the current community. Every member: which notifications
 * this community sends them, their membership, and leaving. Holders of
 * community.update also get "Manage community" (shown from permissions as a
 * hint only: the database authorizes every change).
 */
export function CommunitySettingsScreen({ navigation }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const { refresh } = useCurrentCommunity();
  const { communities, memberships } = useServices();
  const permissions = useCommunityPermissions();
  const load = useCallback(
    () => communities.notificationSettings(community.community_id),
    [communities, community.community_id],
  );
  const loaded = useAsync(load);
  const [overrides, setOverrides] = useState<Partial<CommunityNotificationSettings>>({});
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; message: string } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  if (loaded.status === 'loading') return <LoadingState label="Loading settings…" />;
  if (loaded.status === 'error') {
    return (
      <ErrorState
        title="Settings could not be loaded"
        message={errorMessage(loaded.error)}
        onRetry={loaded.reload}
      />
    );
  }
  const settings = { ...loaded.data, ...overrides };

  // Optimistic: the switch moves at once and moves back if the server refuses.
  const toggle = async (key: keyof CommunityNotificationSettings, value: boolean) => {
    setNotice(null);
    setOverrides((o) => ({ ...o, [key]: value }));
    try {
      const saved = await communities.setNotificationSettings(community.community_id, { [key]: value });
      setOverrides(saved);
    } catch (thrown) {
      setOverrides((o) => ({ ...o, [key]: !value }));
      setNotice({ tone: 'danger', message: errorMessage(thrown) });
    }
  };

  const leave = async () => {
    setLeaving(true);
    setNotice(null);
    try {
      await memberships.leave(community.community_id);
      // Back to the hub first (the stack is reused for the next community), then
      // re-read the memberships: the server no longer lists this one, so the app moves on.
      navigation.popToTop();
      await refresh();
    } catch (thrown) {
      setLeaving(false);
      setConfirmLeave(false);
      const lastManager =
        isServiceError(thrown) && thrown.code === ErrorCode.Forbidden && permissions.can('roles.manage');
      setNotice({
        tone: 'danger',
        message: lastManager
          ? `You're the only one who can manage roles in ${community.name}, so you can't leave yet. Give another member the Owner role first.`
          : errorMessage(thrown),
      });
    }
  };

  const role = roleLabel(community);
  return (
    <Screen testID="community-settings-screen">
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'danger' ? 'settings-error' : 'settings-done'}
        />
      ) : null}

      <Text variant="heading" accessibilityRole="header">
        {`Notifications from ${community.name}`}
      </Text>
      <Card testID="notification-settings">
        {KINDS.map((kind, i) => (
          <View key={kind.key} style={[styles.row, i > 0 && styles.divider]}>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{kind.title}</Text>
              <Text variant="caption" tone="muted">
                {kind.detail}
              </Text>
            </View>
            <Switch
              value={settings[kind.key]}
              onValueChange={(value) => void toggle(kind.key, value)}
              accessibilityLabel={kind.title}
              trackColor={{ true: colors.primary, false: colors.border }}
              testID={`setting-${kind.key}`}
            />
          </View>
        ))}
      </Card>

      {hasAdminTools(permissions.can) ? (
        <>
          <Text variant="heading" accessibilityRole="header">
            Administration
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Admin tools"
            accessibilityHint="Members, invitations, content and moderation"
            onPress={() => navigation.navigate('Admin')}
            style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            testID="settings-admin"
          >
            <Icon name="shield-checkmark-outline" size={22} color="primary" />
            <View style={styles.flex}>
              <Text variant="bodyStrong">Admin tools</Text>
              <Text variant="caption" tone="muted">
                Members, invitations, content and moderation
              </Text>
            </View>
            <Icon name="chevron-forward" size={18} color="textMuted" />
          </Pressable>
        </>
      ) : null}

      {permissions.can('community.update') ? (
        <>
          <Text variant="heading" accessibilityRole="header">
            Manage community
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit community profile"
            accessibilityHint="Name, description, type, time zone, logo and cover"
            onPress={() => navigation.navigate('EditCommunity')}
            style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            testID="manage-community"
          >
            <Icon name="create-outline" size={22} color="primary" />
            <View style={styles.flex}>
              <Text variant="bodyStrong">Community profile</Text>
              <Text variant="caption" tone="muted">
                Name, description, type, time zone, logo and cover
              </Text>
            </View>
            <Icon name="chevron-forward" size={18} color="textMuted" />
          </Pressable>
        </>
      ) : null}

      <Text variant="heading" accessibilityRole="header">
        Your membership
      </Text>
      <Card testID="membership-info">
        <Text>
          {[role, community.joined_at ? `Joined ${formatDate(community.joined_at)}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {confirmLeave ? (
          <View style={styles.confirm}>
            <Text>{`Leave ${community.name}? You will lose access to its posts, events and documents. You can rejoin with a new invitation.`}</Text>
            <View style={styles.actions}>
              <Button
                title="Leave"
                variant="danger"
                fullWidth={false}
                loading={leaving}
                onPress={() => void leave()}
              />
              <Button
                title="Stay"
                variant="ghost"
                fullWidth={false}
                onPress={() => setConfirmLeave(false)}
                disabled={leaving}
              />
            </View>
          </View>
        ) : (
          <Button
            title={`Leave ${community.name}`}
            variant="secondary"
            icon="exit-outline"
            onPress={() => setConfirmLeave(true)}
            accessibilityLabel="Leave community"
          />
        )}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, paddingVertical: t.spacing.sm },
  divider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  flex: { flex: 1, gap: 2 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 60,
    padding: t.spacing.md,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  confirm: { gap: t.spacing.sm },
  actions: { flexDirection: 'row', gap: t.spacing.sm },
}));

import { StackActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, LoadingState, Screen, Text, type IconName } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { openInCommunity } from '@/navigation/openInCommunity';
import { makeStyles, useTheme, type TintName } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Create'>;

interface Action {
  key: string;
  title: string;
  detail: string;
  icon: IconName;
  tint: TintName;
  /** Shown with this permission in the current community (display only: the server checks again). */
  permission?: string;
  go(navigation: Props['navigation']): void;
}

const COMMUNITY_ACTIONS: Action[] = [
  {
    key: 'post',
    title: 'Post',
    detail: 'Share an update with your community',
    icon: 'create-outline',
    tint: 'blue',
    permission: 'posts.create',
    go: (n) => openInCommunity(n, 'Home', 'PostEditor'),
  },
  {
    key: 'photo',
    title: 'Photos',
    detail: 'Post up to 10 photos',
    icon: 'images-outline',
    tint: 'teal',
    permission: 'posts.create',
    go: (n) => openInCommunity(n, 'Home', 'PostEditor', { addPhotos: true }),
  },
  {
    key: 'story',
    title: 'Story',
    detail: 'A photo for 24 hours',
    icon: 'aperture-outline',
    tint: 'purple',
    permission: 'posts.create',
    go: (n) => n.dispatch(StackActions.replace('StoryComposer')),
  },
  {
    key: 'event',
    title: 'Event',
    detail: 'Plan something and collect replies',
    icon: 'calendar-outline',
    tint: 'purple',
    permission: 'events.create',
    go: (n) => openInCommunity(n, 'CommunitiesTab', 'EventEditor'),
  },
  {
    key: 'alert',
    title: 'Quick alert',
    detail: 'Warn neighbours at once, with a photo and your location',
    icon: 'alert-circle-outline',
    tint: 'red',
    permission: 'alerts.create',
    go: (n) => openInCommunity(n, 'CommunitiesTab', 'QuickAlert'),
  },
  {
    key: 'announcement',
    title: 'Announcement',
    detail: 'Official news for every member',
    icon: 'megaphone-outline',
    tint: 'amber',
    permission: 'announcements.create',
    go: (n) => openInCommunity(n, 'CommunitiesTab', 'AnnouncementEditor'),
  },
  {
    key: 'document',
    title: 'Document',
    detail: 'Upload a file to the library',
    icon: 'document-text-outline',
    tint: 'green',
    permission: 'documents.upload',
    go: (n) => openInCommunity(n, 'CommunitiesTab', 'DocumentUpload'),
  },
];

const OTHER_ACTIONS: Action[] = [
  {
    key: 'join',
    title: 'Join a community',
    detail: 'With an invitation link or code',
    icon: 'enter-outline',
    tint: 'blue',
    go: (n) => n.dispatch(StackActions.replace('JoinCommunity')),
  },
  {
    key: 'new-community',
    title: 'Create a community',
    detail: 'Start a new hub and invite people',
    icon: 'add-circle-outline',
    tint: 'teal',
    go: (n) => n.dispatch(StackActions.replace('CreateCommunity')),
  },
];

/**
 * The centre "+" of the tab bar: what the user can create in the current
 * community (from their permissions there), plus joining or creating a
 * community. Every screen it opens is authorized again by the database.
 */
export function CreateScreen({ navigation }: Props) {
  const styles = useStyles();
  const { communities } = useServices();
  const { current } = useCurrentCommunity();
  const loadPermissions = useCallback(
    async () => (current ? communities.myPermissions(current.community_id) : []),
    [communities, current],
  );
  const permissions = useAsync(loadPermissions);
  if (permissions.status === 'loading') return <LoadingState label="Loading…" />;
  const keys = permissions.status === 'success' ? permissions.data : [];
  const allowed = COMMUNITY_ACTIONS.filter((a) => !a.permission || keys.includes(a.permission));

  return (
    <Screen testID="create-screen">
      {current && allowed.length > 0 ? (
        <>
          <Text variant="label" tone="muted">
            {`In ${current.name}`}
          </Text>
          <View style={styles.list}>
            {allowed.map((a) => (
              <ActionRow key={a.key} action={a} onPress={() => a.go(navigation)} />
            ))}
          </View>
        </>
      ) : null}
      <Text variant="label" tone="muted">
        Communities
      </Text>
      <View style={styles.list}>
        {OTHER_ACTIONS.map((a) => (
          <ActionRow key={a.key} action={a} onPress={() => a.go(navigation)} />
        ))}
      </View>
    </Screen>
  );
}

function ActionRow({ action, onPress }: { action: Action; onPress(): void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const tint = colors.tints[action.tint];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.title}
      accessibilityHint={action.detail}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`create-${action.key}`}
    >
      <View style={[styles.tile, { backgroundColor: tint.bg }]}>
        <Icon name={action.icon} size={22} color={tint.fg} />
      </View>
      <View style={styles.flex}>
        <Text variant="bodyStrong">{action.title}</Text>
        <Text variant="caption" tone="muted">
          {action.detail}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color="textMuted" />
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  list: {
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 60,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  tile: { width: 40, height: 40, borderRadius: t.radius.md, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
}));

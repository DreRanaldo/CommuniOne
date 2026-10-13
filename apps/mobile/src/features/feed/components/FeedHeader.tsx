import { useNavigation } from '@react-navigation/native';
import type { ActiveAlert } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Avatar, Icon, Text, type IconName } from '@/components';
import { AlertCard } from '@/features/alerts/AlertCard';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { StoriesBar, type StoriesBarProps } from '@/features/stories/StoriesBar';
import { makeStyles } from '@/theme';

export interface FeedHeaderProps {
  /** The user's first name for the greeting (null: no greeting name). */
  firstName: string | null;
  me: { name: string | null; avatarUri: string | null };
  /** posts.create (display only: the server checks again). */
  canCreate: boolean;
  canCreateEvent: boolean;
  canCreateAlert: boolean;
  onCompose(): void;
  onAddPhotos(): void;
  onNewEvent(): void;
  onNewAlert(): void;
  /** Active urgent and emergency alerts of this community (never hidden by the feed). */
  alerts: ActiveAlert[];
  onOpenAlert(alertId: string): void;
  /** Unread notifications (from the server), shown on the bell. */
  unread: number;
  onOpenNotifications(): void;
  stories: Pick<StoriesBarProps, 'groups' | 'avatars' | 'onAdd' | 'onOpen'>;
}

/** "Good morning" / "Good afternoon" / "Good evening" by the device's local time. */
export function greeting(date = new Date()): string {
  const hour = date.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * The top of the Home feed: a greeting and the current community (tap to
 * switch), notifications, the stories row, "Share something with …" with
 * quick Photo / Event / Alert actions (each only with its permission), and
 * any urgent or emergency alert in force, which always stays above the posts.
 */
export function FeedHeader({
  firstName,
  me,
  canCreate,
  canCreateEvent,
  canCreateAlert,
  onCompose,
  onAddPhotos,
  onNewEvent,
  onNewAlert,
  alerts,
  onOpenAlert,
  unread,
  onOpenNotifications,
  stories,
}: FeedHeaderProps) {
  const styles = useStyles();
  const navigation = useNavigation();
  const community = useCommunity();
  const quick: { key: string; icon: IconName; title: string; label: string; onPress(): void }[] = [
    ...(canCreate
      ? [
          {
            key: 'photo',
            icon: 'image-outline' as const,
            title: 'Photo',
            label: 'Add photos',
            onPress: onAddPhotos,
          },
        ]
      : []),
    ...(canCreateEvent
      ? [
          {
            key: 'event',
            icon: 'calendar-outline' as const,
            title: 'Event',
            label: 'Create an event',
            onPress: onNewEvent,
          },
        ]
      : []),
    ...(canCreateAlert
      ? [
          {
            key: 'alert',
            icon: 'alert-circle-outline' as const,
            title: 'Alert',
            label: 'Send an alert',
            onPress: onNewAlert,
          },
        ]
      : []),
  ];

  return (
    <View>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Switch community. Current community: ${community.name}`}
          onPress={() => navigation.navigate('Communities')}
          style={styles.community}
          hitSlop={6}
          testID="feed-community-switcher"
        >
          <Text variant="caption" tone="muted" testID="feed-greeting">
            {firstName ? `${greeting()}, ${firstName}` : greeting()}
          </Text>
          <Text variant="title" numberOfLines={1}>
            {community.name}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          onPress={onOpenNotifications}
          hitSlop={8}
          style={styles.round}
          testID="feed-notifications"
        >
          <Icon name="notifications-outline" size={22} color="text" />
          {unread > 0 ? (
            <View style={styles.badge} testID="unread-badge">
              <Text variant="caption" style={styles.badgeText}>
                {unread > 99 ? '99+' : unread}
              </Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose community"
          onPress={() => navigation.navigate('Communities')}
          hitSlop={8}
          style={styles.round}
        >
          <Icon name="chevron-down" size={20} color="text" />
        </Pressable>
      </View>

      <StoriesBar {...stories} me={me} canAdd={canCreate} />

      {canCreate ? (
        <View style={styles.composer}>
          <View style={styles.prompt}>
            <Avatar
              uri={me.avatarUri}
              name={me.name}
              size={40}
              label="Your picture"
              testID="composer-avatar"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New post"
              accessibilityHint={`Share something with ${community.name}`}
              onPress={onCompose}
              style={styles.pill}
              testID="feed-compose"
            >
              <Text tone="muted" numberOfLines={1}>
                {`Share something with ${community.name}…`}
              </Text>
            </Pressable>
          </View>
          {quick.length > 0 ? (
            <View style={styles.quick}>
              {quick.map((q) => (
                <Pressable
                  key={q.key}
                  accessibilityRole="button"
                  accessibilityLabel={q.label}
                  onPress={q.onPress}
                  style={({ pressed }) => [styles.quickItem, pressed && styles.pressed]}
                  testID={`feed-quick-${q.key}`}
                >
                  <Icon name={q.icon} size={20} color="textMuted" />
                  <Text variant="label" tone="muted">
                    {q.title}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {alerts.length > 0 ? (
        <View style={styles.alerts} testID="feed-alerts">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} compact onPress={() => onOpenAlert(alert.id)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
    paddingBottom: t.spacing.xs,
  },
  community: { flex: 1, minHeight: t.touchTarget, justifyContent: 'center' },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.danger,
  },
  badgeText: { color: t.colors.textInverse, fontWeight: '700', fontSize: 11, lineHeight: 14 },
  composer: {
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  prompt: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  pill: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.lg,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceMuted,
  },
  quick: { flexDirection: 'row', justifyContent: 'space-around' },
  quickItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    minHeight: 44,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  alerts: { gap: t.spacing.sm, paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md },
}));

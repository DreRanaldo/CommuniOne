import type { Notification } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatRelative } from '@/utils/format';
import { isUnread, notificationKind } from './notificationRules';

/**
 * One notification in the list: its kind (icon and label), title, a short
 * body, the community and the time. Unread ones have a dot and a bold title
 * (and say "Unread" to screen readers), not only a colour.
 */
export function NotificationItem({
  notification: n,
  communityName,
  onPress,
}: {
  notification: Notification;
  communityName?: string | null;
  onPress(): void;
}) {
  const styles = useStyles();
  const kind = notificationKind(n.type);
  const unread = isUnread(n);
  const when = formatRelative(n.created_at);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[unread ? 'Unread' : null, kind.label, n.title, n.body, communityName, when]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, unread && styles.unread, pressed && styles.pressed]}
      testID={`notification-${n.id}`}
    >
      <View style={styles.icon}>
        <Icon name={kind.icon} size={20} color="primary" />
      </View>
      <View style={styles.flex}>
        <Text variant={unread ? 'bodyStrong' : 'body'} numberOfLines={2}>
          {n.title}
        </Text>
        {n.body ? (
          <Text variant="label" tone="muted" numberOfLines={2}>
            {n.body}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted">
          {[kind.label, communityName, when].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {unread ? <View style={styles.dot} testID="notification-unread-dot" /> : null}
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.spacing.md,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  unread: { backgroundColor: t.colors.primarySoft },
  pressed: { opacity: 0.85 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  flex: { flex: 1, gap: t.spacing.xxs },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: t.spacing.sm, backgroundColor: t.colors.primary },
}));

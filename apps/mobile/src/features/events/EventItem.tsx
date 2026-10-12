import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { eventSchedule, statusBadge, type EventLike } from './eventRules';

export interface EventItemProps {
  event: EventLike & { id: string; title: string; location_text: string | null };
  onPress?: () => void;
}

/**
 * An event in a list: a date block, the title, date and time in the event's
 * time zone, the location, and its status (cancelled, completed, ended…) as
 * words. Places and replies are on the detail screen (from the server).
 */
export function EventItem({ event: e, onPress }: EventItemProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const when = eventSchedule(e);
  const badge = statusBadge(e);
  const cancelled = e.status === 'cancelled';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        `Event: ${e.title}`,
        badge,
        `${when.date}, ${when.time} (${when.timezone})`,
        e.location_text,
        e.capacity ? `Limited to ${e.capacity} places` : null,
      ]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID={`event-${e.id}`}
    >
      <View style={styles.header}>
        <Text variant="heading" style={[styles.title, cancelled && styles.struck]}>
          {e.title}
        </Text>
        {badge ? (
          <View style={[styles.badge, cancelled && { borderColor: colors.danger }]}>
            <Text variant="caption" tone={cancelled ? 'danger' : 'muted'}>
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.row}>
        <Icon name="calendar-outline" color="textMuted" size={16} />
        <Text variant="label" tone="muted" style={styles.flex}>
          {when.date} · {when.time}
        </Text>
      </View>
      <View style={styles.row}>
        <Icon name="globe-outline" color="textMuted" size={16} />
        <Text variant="caption" tone="muted">
          {when.timezone}
        </Text>
      </View>
      {e.location_text ? (
        <View style={styles.row}>
          <Icon name="location-outline" color="textMuted" size={16} />
          <Text variant="label" tone="muted" numberOfLines={1} style={styles.flex}>
            {e.location_text}
          </Text>
        </View>
      ) : null}
      {e.capacity ? (
        <View style={styles.row}>
          <Icon name="people-outline" color="textMuted" size={16} />
          <Text variant="caption" tone="muted">
            Limited to {e.capacity} places
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  card: {
    gap: t.spacing.xs,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { opacity: 0.85 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
  title: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
  badge: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
}));

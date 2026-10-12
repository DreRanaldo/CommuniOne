import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { announcementDates, statusBadge, type AnnouncementLike } from './announcementRules';

export interface AnnouncementItemProps {
  announcement: AnnouncementLike & { id: string; title: string; body: string };
  onPress?: () => void;
  /** Fewer lines (community home). */
  compact?: boolean;
}

/**
 * An official announcement in a list. Deliberately unlike a post: an
 * "Announcement" label with a megaphone, a coloured accent (stronger when
 * important), the title first, then priority, dates and a short body.
 * No author, reactions or comments.
 */
export function AnnouncementItem({ announcement: a, onPress, compact }: AnnouncementItemProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const important = a.priority === 'important';
  const badge = statusBadge(a);
  const accent = important ? colors.severity.urgent : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        important ? 'Important announcement' : 'Announcement',
        a.title,
        badge,
        announcementDates(a),
      ]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.card,
        { borderLeftColor: accent },
        important && styles.important,
        pressed && styles.pressed,
      ]}
      testID={`announcement-${a.id}`}
    >
      <View style={styles.eyebrow}>
        <Icon name="megaphone" size={16} color={accent} />
        <Text variant="caption" style={[styles.eyebrowText, { color: accent }]}>
          {important ? 'IMPORTANT ANNOUNCEMENT' : 'ANNOUNCEMENT'}
        </Text>
        {badge ? (
          <View style={styles.badge}>
            <Text variant="caption" tone="muted">
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="heading">{a.title}</Text>
      <Text variant="caption" tone="muted">
        {announcementDates(a)}
      </Text>
      <Text numberOfLines={compact ? 2 : 3} tone="muted">
        {a.body}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  card: {
    gap: t.spacing.xs,
    padding: t.spacing.lg,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderLeftWidth: 6,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  important: { backgroundColor: t.colors.surfaceMuted },
  pressed: { opacity: 0.85 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  eyebrowText: { flex: 1, fontWeight: '700', letterSpacing: 0.5 },
  badge: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
}));

import type { CommunityStats } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Icon, Text, type IconName } from '@/components';
import { makeStyles, useTheme, type TintName } from '@/theme';
import type { CommunitySection } from '@/types/navigation';

type Count = (stats: CommunityStats) => string | null;

const plural = (n: number | null, one: string, many: string) =>
  n === null ? null : n === 1 ? `1 ${one}` : `${n.toLocaleString()} ${many}`;

const TILES: { section: CommunitySection; title: string; icon: IconName; tint: TintName; count: Count }[] = [
  {
    section: 'feed',
    title: 'Feed',
    icon: 'chatbubble-outline',
    tint: 'blue',
    count: (s) => plural(s.posts_today, 'new today', 'new today'),
  },
  {
    section: 'announcements',
    title: 'Announcements',
    icon: 'megaphone-outline',
    tint: 'amber',
    count: (s) => plural(s.current_announcements, 'current', 'current'),
  },
  {
    section: 'alerts',
    title: 'Alerts',
    icon: 'alert-circle-outline',
    tint: 'red',
    count: (s) => plural(s.active_alerts, 'active', 'active'),
  },
  {
    section: 'events',
    title: 'Events',
    icon: 'calendar-outline',
    tint: 'purple',
    count: (s) => plural(s.upcoming_events, 'upcoming', 'upcoming'),
  },
  {
    section: 'documents',
    title: 'Documents',
    icon: 'document-text-outline',
    tint: 'green',
    count: (s) => plural(s.document_count, 'file', 'files'),
  },
  {
    section: 'members',
    title: 'Members',
    icon: 'people-outline',
    tint: 'blue',
    count: (s) => plural(s.member_count, 'person', 'people'),
  },
];

/**
 * Shortcuts to every part of the community, two per row, each with its count
 * from community_stats() when the server provides one (a count the user may
 * not see is left out, never guessed).
 */
export function SectionTiles({
  stats,
  onOpen,
}: {
  stats: CommunityStats | null;
  onOpen(section: CommunitySection): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.grid} testID="section-tiles">
      {TILES.map(({ section, title, icon, tint, count }) => {
        const detail = stats ? count(stats) : null;
        const colour = colors.tints[tint];
        return (
          <Pressable
            key={section}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityValue={detail ? { text: detail } : undefined}
            onPress={() => onOpen(section)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
            testID={`tile-${section}`}
          >
            <View style={[styles.icon, { backgroundColor: colour.bg }]}>
              <Icon name={icon} size={22} color={colour.fg} />
            </View>
            <View style={styles.text}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {title}
              </Text>
              {detail ? (
                <Text variant="caption" tone="muted" numberOfLines={1} testID={`tile-${section}-count`}>
                  {detail}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md },
  tile: {
    flexBasis: '46%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 72,
    padding: t.spacing.md,
    borderRadius: t.radius.lg + 4,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  icon: {
    width: 44,
    height: 44,
    borderRadius: t.radius.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2 },
}));

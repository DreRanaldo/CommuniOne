import { Pressable, View } from 'react-native';
import { Icon, SectionHeader, Text, type IconName } from '@/components';
import { makeStyles } from '@/theme';
import type { CommunitySection } from '@/types/navigation';

const ACTIONS: { section: CommunitySection; title: string; icon: IconName }[] = [
  { section: 'feed', title: 'Feed', icon: 'chatbubbles-outline' },
  { section: 'announcements', title: 'Announcements', icon: 'megaphone-outline' },
  { section: 'alerts', title: 'Alerts', icon: 'warning-outline' },
  { section: 'events', title: 'Events', icon: 'calendar-outline' },
  { section: 'documents', title: 'Documents', icon: 'document-text-outline' },
  { section: 'members', title: 'Members', icon: 'people-outline' },
];

/** Shortcuts to every part of the community. */
export function QuickActions({ onOpen }: { onOpen(section: CommunitySection): void }) {
  const styles = useStyles();
  return (
    <View style={styles.container}>
      <SectionHeader title="Explore" icon="grid-outline" />
      <View style={styles.grid}>
        {ACTIONS.map(({ section, title, icon }) => (
          <Pressable
            key={section}
            accessibilityRole="button"
            accessibilityLabel={title}
            onPress={() => onOpen(section)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <Icon name={icon} color="primary" />
            <Text variant="label">{title}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  tile: {
    flexBasis: '30%',
    flexGrow: 1,
    minHeight: t.touchTarget * 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.xs,
    padding: t.spacing.sm,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
}));

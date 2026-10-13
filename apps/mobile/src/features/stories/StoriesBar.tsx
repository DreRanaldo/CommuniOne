import { Pressable, ScrollView, View } from 'react-native';
import { Avatar, Icon, Text } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { firstName, type StoryGroup } from './storyRules';

export interface StoriesBarProps {
  groups: StoryGroup[];
  avatars: Record<string, string | null>;
  me: { name: string | null; avatarUri: string | null };
  /** posts.create in this community (display only: the server checks again). */
  canAdd: boolean;
  onAdd(): void;
  onOpen(authorId: string): void;
}

const SIZE = 64;

/**
 * The stories row at the top of the feed: "Your story" first (with a + to
 * add one), then one bubble per member with active stories. A coloured ring
 * marks stories not seen yet; seen ones get a grey ring.
 */
export function StoriesBar({ groups, avatars, me, canAdd, onAdd, onOpen }: StoriesBarProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const mine = groups.find((g) => g.mine);
  const others = groups.filter((g) => !g.mine);
  if (!canAdd && !mine && others.length === 0) return null;

  const ring = (group: StoryGroup | undefined) =>
    group
      ? { borderColor: group.allSeen ? colors.border : colors.storyRing }
      : { borderColor: 'transparent' };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      testID="stories-bar"
      accessibilityLabel="Stories"
    >
      {canAdd || mine ? (
        <View style={styles.item}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mine ? 'Your story' : 'Add to your story'}
            onPress={mine ? () => onOpen(mine.authorId) : onAdd}
            style={[styles.ring, ring(mine)]}
            testID="story-mine"
          >
            <Avatar uri={me.avatarUri} name={me.name} size={SIZE} label="" testID="story-mine-avatar" />
          </Pressable>
          {canAdd && mine ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to your story"
              onPress={onAdd}
              hitSlop={8}
              style={styles.plus}
              testID="story-add"
            >
              <Icon name="add" size={16} color="onPrimary" />
            </Pressable>
          ) : canAdd ? (
            // The bubble itself adds a story: the badge is only a visual cue.
            <View style={styles.plus} pointerEvents="none" importantForAccessibility="no-hide-descendants">
              <Icon name="add" size={16} color="onPrimary" />
            </View>
          ) : null}
          <Text variant="caption" numberOfLines={1} style={styles.label}>
            Your story
          </Text>
        </View>
      ) : null}
      {others.map((group) => (
        <View key={group.authorId} style={styles.item}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Story by ${group.name}, ${group.allSeen ? 'seen' : 'new'}`}
            onPress={() => onOpen(group.authorId)}
            style={[styles.ring, ring(group)]}
            testID={`story-${group.authorId}`}
          >
            <Avatar uri={avatars[group.authorId] ?? null} name={group.name} size={SIZE} label="" />
          </Pressable>
          <Text variant="caption" numberOfLines={1} style={styles.label}>
            {firstName(group.name)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const useStyles = makeStyles((t) => ({
  row: { gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
  item: { width: SIZE + 12, alignItems: 'center', gap: t.spacing.xs },
  ring: {
    width: SIZE + 10,
    height: SIZE + 10,
    borderRadius: (SIZE + 10) / 2,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plus: {
    position: 'absolute',
    top: SIZE - 12,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: t.colors.background,
    backgroundColor: t.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { maxWidth: SIZE + 12, color: t.colors.text },
}));

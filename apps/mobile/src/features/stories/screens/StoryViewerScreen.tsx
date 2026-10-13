import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StatusBar, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, Button, Icon, LoadingState, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { firstUnseen, groupStories, storyAge, type StoryGroup } from '../storyRules';

type Props = NativeStackScreenProps<RootStackParamList, 'StoryViewer'>;

/** How long one story stays on screen before moving on. */
export const STORY_SECONDS = 6;

/**
 * Full-screen stories of the current community, starting with one author and
 * moving on to the next. Stories are re-read from the server when opened
 * (only active stories the user may see), pictures come through short-lived
 * signed links, and each story shown is marked seen. The author (and a
 * moderator) can delete a story; the author sees how many people saw it.
 */
export function StoryViewerScreen({ route, navigation }: Props) {
  const { communityId, authorId } = route.params;
  const { current } = useCurrentCommunity();
  const { stories } = useServices();
  const { session } = useAuth();
  const myId = session?.user.id ?? null;
  const load = useCallback(async () => {
    // Only the current community's stories (a link cannot open another one's).
    if (current?.community_id !== communityId) return [];
    const groups = groupStories(await stories.list(communityId), myId);
    const urls = await stories.imageUrls(
      groups.flatMap((g) => g.stories.map((s) => s.storage_path)).slice(0, 100),
    );
    return groups.map((g) => ({ ...g, urls }));
  }, [stories, communityId, current?.community_id, myId]);
  const state = useAsync(load);

  if (state.status === 'loading') return <LoadingState label="Loading stories…" />;
  const groups = state.status === 'success' ? state.data : [];
  const start = groups.findIndex((g) => g.authorId === authorId);
  if (state.status === 'error' || start < 0) {
    return (
      <Gone
        message={state.status === 'error' ? errorMessage(state.error) : 'This story is no longer available.'}
        onClose={() => navigation.goBack()}
      />
    );
  }
  return (
    <Viewer
      groups={groups}
      start={start}
      urls={groups[0]!.urls}
      communityId={communityId}
      onClose={() => navigation.goBack()}
    />
  );
}

function Gone({ message, onClose }: { message: string; onClose(): void }) {
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.screen} testID="story-viewer">
      <View style={styles.center}>
        <Text style={styles.light} testID="story-gone">
          {message}
        </Text>
        <Button title="Close" variant="secondary" fullWidth={false} onPress={onClose} />
      </View>
    </SafeAreaView>
  );
}

function Viewer({
  groups: initial,
  start,
  urls,
  communityId,
  onClose,
}: {
  groups: StoryGroup[];
  start: number;
  urls: Record<string, string>;
  communityId: string;
  onClose(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { stories, communities } = useServices();
  const [groups, setGroups] = useState(initial);
  const [position, setPosition] = useState(() => ({ group: start, story: firstUnseen(initial[start]!) }));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loadPermissions = useCallback(
    () => communities.myPermissions(communityId),
    [communities, communityId],
  );
  const permissions = useAsync(loadPermissions);
  const canModerate = permissions.status === 'success' && permissions.data.includes('posts.moderate');

  const group = groups[position.group]!;
  const story = group.stories[position.story]!;

  const next = useCallback(() => {
    setConfirming(false);
    setProblem(null);
    setPosition((p) => {
      const g = groups[p.group]!;
      if (p.story + 1 < g.stories.length) return { group: p.group, story: p.story + 1 };
      if (p.group + 1 < groups.length)
        return { group: p.group + 1, story: firstUnseen(groups[p.group + 1]!) };
      return p;
    });
    const atEnd = position.group === groups.length - 1 && position.story === group.stories.length - 1;
    if (atEnd) onClose();
  }, [groups, position, group.stories.length, onClose]);

  const previous = () => {
    setConfirming(false);
    setProblem(null);
    setPosition((p) => {
      if (p.story > 0) return { group: p.group, story: p.story - 1 };
      if (p.group > 0) return { group: p.group - 1, story: groups[p.group - 1]!.stories.length - 1 };
      return p;
    });
  };

  // Seen: recorded on the server once shown (best effort).
  useEffect(() => {
    if (!story.viewed_by_me) void stories.markViewed(story.id).catch(() => false);
  }, [stories, story.id, story.viewed_by_me]);

  // Moves on by itself, unless the user is deciding to delete.
  useEffect(() => {
    if (confirming) return undefined;
    const timer = setTimeout(next, STORY_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [next, confirming, story.id]);

  const remove = async () => {
    setProblem(null);
    try {
      await stories.delete(story.id);
      const left = groups
        .map((g, i) =>
          i === position.group ? { ...g, stories: g.stories.filter((s) => s.id !== story.id) } : g,
        )
        .filter((g) => g.stories.length > 0);
      if (left.length === 0) return onClose();
      setGroups(left);
      setConfirming(false);
      setPosition(({ group: gi }) => {
        const g = Math.min(gi, left.length - 1);
        return { group: g, story: Math.min(position.story, left[g]!.stories.length - 1) };
      });
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    }
  };

  const url = urls[story.storage_path];
  const canDelete = group.mine || canModerate;
  return (
    <View style={styles.screen} testID="story-viewer">
      <StatusBar barStyle="light-content" />
      {url ? (
        <Image
          source={{ uri: url }}
          style={styles.image}
          resizeMode="contain"
          accessibilityRole="image"
          accessibilityLabel={story.caption ? `Story: ${story.caption}` : `Story by ${group.name}`}
          testID="story-image"
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.light}>The picture could not be loaded.</Text>
        </View>
      )}
      {/* Tap zones: left goes back, right goes on. */}
      <View style={styles.zones}>
        <Pressable
          style={styles.zone}
          accessibilityRole="button"
          accessibilityLabel="Previous story"
          onPress={previous}
        />
        <Pressable
          style={styles.zone}
          accessibilityRole="button"
          accessibilityLabel="Next story"
          onPress={next}
        />
      </View>
      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <View style={styles.bars} testID="story-progress">
          {group.stories.map((s, i) => (
            <View key={s.id} style={[styles.bar, i <= position.story && styles.barDone]} />
          ))}
        </View>
        <View style={styles.header}>
          <Avatar uri={null} name={group.name} size={36} label="" />
          <View style={styles.flex}>
            <Text variant="label" style={styles.light} testID="story-author">
              {group.mine ? 'Your story' : group.name}
            </Text>
            <Text variant="caption" style={styles.dim}>
              {storyAge(story.created_at)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close stories"
            onPress={onClose}
            hitSlop={10}
          >
            <Icon name="close" size={28} color={colors.media.text} />
          </Pressable>
        </View>
      </SafeAreaView>
      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        {story.caption ? (
          <Text style={[styles.light, styles.caption]} testID="story-caption">
            {story.caption}
          </Text>
        ) : null}
        {problem ? (
          <Text style={styles.light} accessibilityRole="alert" testID="story-error">
            {problem}
          </Text>
        ) : null}
        <View style={styles.footer}>
          {group.mine ? (
            <View style={styles.seen}>
              <Icon name="eye-outline" size={18} color={colors.media.text} />
              <Text variant="caption" style={styles.light} testID="story-views">
                {`Seen by ${story.view_count ?? 0}`}
              </Text>
            </View>
          ) : (
            <View />
          )}
          {canDelete ? (
            confirming ? (
              <View style={styles.seen}>
                <Button
                  title="Delete story"
                  variant="danger"
                  fullWidth={false}
                  onPress={() => void remove()}
                />
                <Button
                  title="Keep"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setConfirming(false)}
                />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete this story"
                onPress={() => setConfirming(true)}
                hitSlop={10}
              >
                <Icon name="trash-outline" size={24} color={colors.media.text} />
              </Pressable>
            )
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  screen: { flex: 1, backgroundColor: t.colors.media.backdrop },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.md,
    padding: t.spacing.xl,
  },
  image: { ...StyleSheetFill },
  zones: { ...StyleSheetFill, flexDirection: 'row' },
  zone: { flex: 1 },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: t.spacing.md,
    gap: t.spacing.sm,
  },
  bars: { flexDirection: 'row', gap: 4, paddingTop: t.spacing.sm },
  bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: t.colors.media.track },
  barDone: { backgroundColor: t.colors.media.text },
  header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
  light: { color: t.colors.media.text },
  dim: { color: t.colors.media.dim },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: t.spacing.lg,
    gap: t.spacing.sm,
    backgroundColor: t.colors.media.shade,
  },
  caption: { fontSize: 16, lineHeight: 22 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  seen: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
}));

const StyleSheetFill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

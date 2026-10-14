import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { EmptyState, Text } from '@/components';
import { FeedList } from '@/features/feed/screens/FeedScreen';
import type { FeedStatus } from '@/features/feed/useFeed';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Moderation'>;

const VIEWS: { status: FeedStatus; label: string }[] = [
  { status: 'hidden', label: 'Hidden' },
  { status: 'deleted', label: 'Deleted' },
];

/**
 * Hidden and deleted posts of the current community, for moderators
 * (posts.moderate). They are no longer offered in the feed: the database
 * returns them only to moderators (and a post's own author). Restoring a
 * post is a moderation action, checked by the database.
 */
export function ModerationScreen({ navigation }: Props) {
  const styles = useStyles();
  const permissions = useCommunityPermissions();
  const [status, setStatus] = useState<FeedStatus>('hidden');
  const refreshed = useCallback(async () => {}, []);

  if (!permissions.can('posts.moderate')) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Not available"
        message="Only moderators can review hidden and deleted posts."
      />
    );
  }

  const header = (
    <View style={styles.tabs} accessibilityRole="tablist">
      {VIEWS.map((v) => (
        <Pressable
          key={v.status}
          accessibilityRole="tab"
          accessibilityState={{ selected: v.status === status }}
          accessibilityLabel={v.label}
          onPress={() => setStatus(v.status)}
          style={[styles.tab, v.status === status && styles.tabSelected]}
        >
          <Text variant="label" tone={v.status === status ? 'default' : 'muted'}>
            {v.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <View style={styles.container} testID="moderation-screen">
      {/* A new list per view: no rows of one view leak into another. */}
      <FeedList
        key={status}
        status={status}
        header={header}
        canCreate={false}
        onRefreshed={refreshed}
        onCompose={() => {}}
        onEdit={(postId) => navigation.navigate('PostEditor', { postId })}
        onOpen={(post) => navigation.navigate('PostDetail', { postId: post.id, post })}
        onOpenAuthor={(userId) => navigation.navigate('MemberProfile', { userId })}
      />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  tabs: {
    flexDirection: 'row',
    gap: t.spacing.xs,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  tab: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
  },
  tabSelected: { backgroundColor: t.colors.surfaceMuted },
}));

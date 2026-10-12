import type { FeedPost } from '@communione/services';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatDateTime } from '@/utils/format';

/** A recent post, summarised (author, time, text, counts). */
export function PostCard({ post }: { post: FeedPost }) {
  const styles = useStyles();
  // A deleted account's posts stay, without a name (account-deletion policy).
  const author = post.author_display_name?.trim() || 'Deleted User';
  return (
    <Card testID={`post-${post.id}`}>
      <View style={styles.row}>
        <Text variant="label" style={styles.flex} numberOfLines={1}>
          {author}
        </Text>
        <Text variant="caption" tone="muted">
          {formatDateTime(post.created_at)}
        </Text>
      </View>
      <Text numberOfLines={3}>{post.body}</Text>
      <View style={styles.row}>
        <Icon name="heart-outline" color="textMuted" size={16} />
        <Text variant="caption" tone="muted" accessibilityLabel={`${post.reaction_count} reactions`}>
          {post.reaction_count}
        </Text>
        <Icon name="chatbubble-outline" color="textMuted" size={16} />
        <Text variant="caption" tone="muted" accessibilityLabel={`${post.comment_count} comments`}>
          {post.comment_count}
        </Text>
      </View>
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
}));

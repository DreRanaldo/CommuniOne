import { useNavigation } from '@react-navigation/native';
import type { ActiveAlert } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Avatar, Icon, Text } from '@/components';
import { AlertCard } from '@/features/alerts/AlertCard';
import { CommunityLogo } from '@/features/communities/components/CommunityLogo';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { makeStyles } from '@/theme';

export interface FeedHeaderProps {
  canCreate: boolean;
  onCompose(): void;
  onAddPhotos(): void;
  /** Active urgent and emergency alerts of this community (never hidden by the feed). */
  alerts: ActiveAlert[];
  onOpenAlert(alertId: string): void;
}

/**
 * The top of the Home feed: which community this is (logo and name, tap to
 * switch), a create button, the "Share with your community" prompt, and any
 * urgent or emergency alert in force, which always stays above the posts.
 */
export function FeedHeader({ canCreate, onCompose, onAddPhotos, alerts, onOpenAlert }: FeedHeaderProps) {
  const styles = useStyles();
  const navigation = useNavigation();
  const community = useCommunity();
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
          <CommunityLogo community={community} size={40} />
          <View style={styles.flex}>
            <Text variant="heading" numberOfLines={1}>
              {community.name}
            </Text>
            <Text variant="caption" tone="muted">
              Current community
            </Text>
          </View>
          <Icon name="chevron-down" size={20} color="textMuted" />
        </Pressable>
        {canCreate ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New post"
            onPress={onCompose}
            hitSlop={8}
            style={styles.iconButton}
          >
            <Icon name="add-circle-outline" size={28} color="text" />
          </Pressable>
        ) : null}
      </View>

      {alerts.length > 0 ? (
        <View style={styles.alerts} testID="feed-alerts">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} compact onPress={() => onOpenAlert(alert.id)} />
          ))}
        </View>
      ) : null}

      {canCreate ? (
        <View style={styles.prompt}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share with your community. Post an update or add photos"
            onPress={onCompose}
            style={styles.promptText}
            testID="feed-compose"
          >
            <Avatar uri={null} name={null} size={36} label="Your picture" testID="composer-avatar" />
            <View style={styles.flex}>
              <Text variant="bodyStrong">Share with your community</Text>
              <Text variant="caption" tone="muted">
                Post an update or add photos…
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add photos"
            onPress={onAddPhotos}
            hitSlop={8}
            style={styles.iconButton}
          >
            <Icon name="images-outline" size={24} color="primary" />
          </Pressable>
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
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  community: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: t.touchTarget,
  },
  flex: { flex: 1 },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  alerts: {
    gap: t.spacing.sm,
    padding: t.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  promptText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: t.touchTarget,
  },
}));

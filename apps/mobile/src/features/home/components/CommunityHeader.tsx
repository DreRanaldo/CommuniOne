import type { Community, MyCommunity } from '@communione/services';
import { Image, View } from 'react-native';
import { Text } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { CommunityLogo } from '../../communities/components/CommunityLogo';
import { roleLabel, typeLabel } from '../../communities/selection';

/** Who this home belongs to: cover, logo, name, type, the user's role, description. */
export function CommunityHeader({
  community,
  details,
}: {
  community: MyCommunity;
  details: Community | null;
}) {
  const styles = useStyles();
  const { communities } = useServices();
  const cover = details ? communities.imageUrl(details, 'cover') : null;
  const role = roleLabel(community);
  return (
    <View style={styles.container} testID="community-header">
      {cover ? (
        <Image
          source={{ uri: cover }}
          style={styles.cover}
          accessibilityRole="image"
          accessibilityLabel={`${community.name} cover image`}
          testID="community-cover"
        />
      ) : null}
      <View style={styles.row}>
        <CommunityLogo community={community} size={64} />
        <View style={styles.text}>
          <Text variant="title">{community.name}</Text>
          <Text tone="muted">{[typeLabel(community.community_type), role].filter(Boolean).join(' · ')}</Text>
        </View>
      </View>
      {details?.description ? (
        <Text tone="muted" numberOfLines={3}>
          {details.description}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.md },
  cover: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceMuted,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  text: { flex: 1, gap: t.spacing.xxs },
}));

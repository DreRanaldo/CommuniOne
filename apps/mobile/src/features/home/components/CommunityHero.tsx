import type { Community, MyCommunity } from '@communione/services';
import { ImageBackground, View } from 'react-native';
import { Text } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { CommunityLogo } from '../../communities/components/CommunityLogo';
import { roleLabel, typeLabel } from '../../communities/selection';

/**
 * The hub's welcome card: the community's cover photo (darkened for legible
 * text) or a brand-coloured card, its logo, type, "Welcome home" and, when
 * the server reports it, how many members it has. Communities are always
 * private (members only), so it says so.
 */
export function CommunityHero({
  community,
  details,
  firstName,
  memberCount,
}: {
  community: MyCommunity;
  details: Community | null;
  firstName: string | null;
  memberCount: number | null;
}) {
  const styles = useStyles();
  const { communities } = useServices();
  const cover = details ? communities.imageUrl(details, 'cover') : null;
  const role = roleLabel(community);
  const content = (
    <View style={styles.shade}>
      <View style={styles.logo}>
        <CommunityLogo community={community} size={56} />
      </View>
      <Text variant="caption" style={styles.eyebrow}>
        {`${typeLabel(community.community_type).toUpperCase()} · PRIVATE COMMUNITY`}
      </Text>
      <Text variant="title" style={styles.light} testID="hub-welcome">
        {firstName ? `Welcome home, ${firstName}` : 'Welcome home'}
      </Text>
      {memberCount !== null ? (
        <Text variant="label" style={styles.dim} testID="hub-members">
          {memberCount === 1
            ? '1 member is building this community.'
            : `${memberCount.toLocaleString()} members are building a stronger community together.`}
        </Text>
      ) : null}
      {role ? (
        <Text variant="caption" style={styles.dim}>
          {`You are ${/^[AEIOU]/i.test(role) ? 'an' : 'a'} ${role}`}
        </Text>
      ) : null}
    </View>
  );
  return (
    <View style={styles.card} testID="community-header">
      {cover ? (
        <ImageBackground
          source={{ uri: cover }}
          style={styles.fill}
          imageStyle={styles.image}
          accessibilityRole="image"
          accessibilityLabel={`${community.name} cover image`}
          testID="community-cover"
        >
          {content}
        </ImageBackground>
      ) : (
        <View style={[styles.fill, styles.plain]}>{content}</View>
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  card: { borderRadius: t.radius.lg + 8, overflow: 'hidden', minHeight: 220 },
  fill: { flex: 1, minHeight: 220 },
  image: { borderRadius: t.radius.lg + 8 },
  plain: { backgroundColor: t.colors.primaryPressed },
  shade: {
    flex: 1,
    justifyContent: 'flex-end',
    gap: t.spacing.xs,
    padding: t.spacing.xl,
    backgroundColor: t.colors.media.shade,
  },
  logo: {
    alignSelf: 'flex-start',
    marginBottom: t.spacing.sm,
    padding: 3,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface,
  },
  eyebrow: { color: t.colors.media.dim, fontWeight: '700', letterSpacing: 1.2 },
  light: { color: t.colors.media.text },
  dim: { color: t.colors.media.dim },
}));

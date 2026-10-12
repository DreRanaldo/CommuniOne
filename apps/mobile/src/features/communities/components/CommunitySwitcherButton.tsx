import type { MyCommunity } from '@communione/services';
import { useNavigation } from '@react-navigation/native';
import { Pressable } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { CommunityLogo } from './CommunityLogo';

/** Header title of the community hub: the current community, tap to switch. */
export function CommunitySwitcherButton({ community }: { community: MyCommunity }) {
  const styles = useStyles();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch community. Current community: ${community.name}`}
      onPress={() => navigation.navigate('Communities')}
      style={styles.button}
      hitSlop={8}
      testID="community-switcher"
    >
      <CommunityLogo name={community.name} logoUrl={community.logo_url} size={28} />
      <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
        {community.name}
      </Text>
      <Icon name="chevron-down" size={18} color="textMuted" />
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  button: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, maxWidth: 260 },
  name: { flexShrink: 1 },
}));

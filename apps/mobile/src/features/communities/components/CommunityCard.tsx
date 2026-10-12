import type { MyCommunity } from '@communione/services';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { roleLabel, typeLabel, unavailableReason } from '../selection';
import { CommunityLogo } from './CommunityLogo';

export interface CommunityCardProps {
  community: MyCommunity;
  current: boolean;
  onPress: () => void;
  busy?: boolean;
}

/**
 * One membership in the community list: logo, name, type, the user's role
 * (a display label only), and whether it is the current community or cannot
 * be entered (pending, suspended, archived).
 */
export function CommunityCard({ community, current, onPress, busy }: CommunityCardProps) {
  const styles = useStyles();
  const type = typeLabel(community.community_type);
  const role = roleLabel(community);
  const reason = unavailableReason(community);
  const label = [community.name, type, role, reason, current ? 'current community' : null]
    .filter(Boolean)
    .join(', ');

  return (
    <Card
      onPress={onPress}
      selected={current}
      disabled={!!reason || busy}
      accessibilityLabel={label}
      testID={`community-card-${community.community_id}`}
    >
      <View style={styles.row}>
        <CommunityLogo name={community.name} logoUrl={community.logo_url} />
        <View style={styles.text}>
          <Text variant="heading" numberOfLines={2}>
            {community.name}
          </Text>
          <Text variant="caption" tone="muted">
            {[type, role].filter(Boolean).join(' · ')}
          </Text>
          {reason ? (
            <Text variant="caption" tone="danger">
              {reason}
            </Text>
          ) : null}
        </View>
        {current ? (
          <View style={styles.current}>
            <Icon name="checkmark-circle" color="primary" />
            <Text variant="caption" tone="primary">
              Current
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  text: { flex: 1, gap: t.spacing.xxs },
  current: { alignItems: 'center', gap: t.spacing.xxs },
}));

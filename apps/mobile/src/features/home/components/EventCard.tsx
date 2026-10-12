import type { CommunityEvent } from '@communione/services';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatDateTime } from '@/utils/format';

/** An upcoming event, in the event's (community's) time zone. */
export function EventCard({ event }: { event: CommunityEvent }) {
  const styles = useStyles();
  return (
    <Card testID={`event-${event.id}`}>
      <Text variant="bodyStrong">{event.title}</Text>
      <View style={styles.row}>
        <Icon name="time-outline" color="textMuted" size={16} />
        <Text variant="label" tone="muted">
          {formatDateTime(event.starts_at, event.timezone)}
        </Text>
      </View>
      {event.location_text ? (
        <View style={styles.row}>
          <Icon name="location-outline" color="textMuted" size={16} />
          <Text variant="label" tone="muted" numberOfLines={1} style={styles.flex}>
            {event.location_text}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
}));

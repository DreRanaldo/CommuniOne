import type { CurrentAnnouncement } from '@communione/services';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatDate } from '@/utils/format';

/** A current announcement; important ones are marked. */
export function AnnouncementCard({ announcement }: { announcement: CurrentAnnouncement }) {
  const styles = useStyles();
  const important = announcement.priority === 'important';
  return (
    <Card testID={`announcement-${announcement.id}`} selected={important}>
      <View style={styles.row}>
        {important ? (
          <>
            <Icon name="star" color="primary" size={16} />
            <Text variant="caption" tone="primary" style={styles.flex}>
              Important
            </Text>
          </>
        ) : (
          <View style={styles.flex} />
        )}
        <Text variant="caption" tone="muted">
          {formatDate(announcement.published_at)}
        </Text>
      </View>
      <Text variant="bodyStrong">{announcement.title}</Text>
      <Text numberOfLines={3} tone="muted">
        {announcement.body}
      </Text>
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1 },
}));

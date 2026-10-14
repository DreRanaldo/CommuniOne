import { useCallback } from 'react';
import { Image, Linking, View } from 'react-native';
import { Button, Icon, Text } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { mapsLink } from '@/lib/location';
import { makeStyles } from '@/theme';
import { accuracyLine } from './quickAlerts';

interface Attachable {
  image_path: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
}

/**
 * An alert's photo (short-lived signed link from the private alert-images
 * bucket) and the location its sender chose to share, with "Open in Maps".
 * Both come with the alert row, so they reach exactly whoever may see it.
 */
export function AlertAttachments({ alert }: { alert: Attachable }) {
  const styles = useStyles();
  const { alerts } = useServices();
  const path = alert.image_path;
  const load = useCallback(async () => (path ? alerts.imageUrl({ image_path: path }) : null), [alerts, path]);
  const image = useAsync(load);
  const hasLocation = alert.latitude !== null && alert.longitude !== null;
  if (!path && !hasLocation) return null;
  return (
    <View style={styles.box}>
      {path && image.status === 'success' && image.data ? (
        <Image
          source={{ uri: image.data }}
          style={styles.photo}
          resizeMode="cover"
          accessibilityRole="image"
          accessibilityLabel="Photo sent with this alert"
          testID="alert-photo"
        />
      ) : null}
      {path && image.status === 'success' && !image.data ? (
        <Text tone="muted">The photo is not available.</Text>
      ) : null}
      {hasLocation ? (
        <View style={styles.location} testID="alert-location">
          <Icon name="location" size={20} color="primary" />
          <Text style={styles.flex}>
            {['Location shared by the sender', accuracyLine(alert.location_accuracy_m)]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Button
            title="Open in Maps"
            variant="secondary"
            fullWidth={false}
            icon="map-outline"
            onPress={() => void Linking.openURL(mapsLink(alert.latitude!, alert.longitude!))}
          />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  box: { gap: t.spacing.sm },
  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceMuted,
  },
  location: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

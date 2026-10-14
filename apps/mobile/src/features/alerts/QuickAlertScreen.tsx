import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Banner, Button, EmptyState, Icon, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useDependencies } from '@/lib/dependencies';
import { LocationUnavailableError, type CurrentPosition } from '@/lib/location';
import { CameraUnavailableError, type PickedImage } from '@/lib/media';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { SEVERITY_INFO, alertError } from './alertRules';
import { accuracyLine, presetsFor, reachLine, type QuickAlertPreset } from './quickAlerts';

type Props = NativeStackScreenProps<CommunityStackParamList, 'QuickAlert'>;

export const DETAILS_MAX = 1000;

/**
 * Quick alert: pick what is happening, optionally add details, your current
 * location and a photo (camera or library), and send it to the community at
 * once. Shown with alerts.create (members since migration 31); the database
 * re-checks everything (emergency needs alerts.manage; 20 alerts per hour).
 * Location is read only when the sender taps "Share my location".
 */
export function QuickAlertScreen({ navigation }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { services, media, location } = useDependencies();
  const [preset, setPreset] = useState<QuickAlertPreset | null>(null);
  const [details, setDetails] = useState('');
  const [position, setPosition] = useState<CurrentPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!permissions.can('alerts.create')) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Not available"
        message={`You can't send alerts in ${community.name}.`}
      />
    );
  }

  const shareLocation = async () => {
    setError(null);
    setLocating(true);
    try {
      setPosition(await location.current());
    } catch (thrown) {
      setError(
        thrown instanceof LocationUnavailableError ? thrown.message : 'Your location could not be found.',
      );
    } finally {
      setLocating(false);
    }
  };

  const addPhoto = async (from: 'camera' | 'library') => {
    setError(null);
    try {
      const picked = from === 'camera' ? await media.takePhoto() : ((await media.pickPhotos(1))[0] ?? null);
      if (picked) setPhoto(picked);
    } catch (thrown) {
      setError(thrown instanceof CameraUnavailableError ? thrown.message : 'The photo could not be added.');
    }
  };

  const send = async () => {
    if (!preset) return;
    setSending(true);
    setError(null);
    try {
      const sent = await services.alerts.create({
        communityId: community.community_id,
        title: preset.title,
        body: details.trim() || preset.body,
        severity: preset.severity,
        publish: true,
        location: position
          ? { latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy }
          : null,
        image: photo ? { file: photo.bytes, mimeType: photo.mimeType } : null,
      });
      navigation.replace('AlertDetail', { alertId: sent.id, sent: true });
    } catch (thrown) {
      setError(alertError(thrown));
      setSending(false);
    }
  };

  const presets = presetsFor(permissions.can);

  return (
    <Screen testID="quick-alert-screen">
      <Banner
        tone="info"
        title="In danger?"
        message="Call your local emergency number first. Alerts reach your community, not emergency services."
      />
      {error ? <Banner tone="danger" message={error} testID="quick-alert-error" /> : null}

      <Text variant="heading" accessibilityRole="header">
        {"What's happening?"}
      </Text>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="What's happening?">
        {presets.map((p) => {
          const selected = preset?.key === p.key;
          const color = colors.severity[p.severity];
          return (
            <Pressable
              key={p.key}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${p.title}, ${SEVERITY_INFO[p.severity].label}`}
              onPress={() => setPreset(p)}
              style={[styles.tile, selected && { borderColor: color, backgroundColor: colors.surfaceMuted }]}
              testID={`quick-${p.key}`}
            >
              <Icon name={p.icon} size={26} color={color} />
              <Text variant="label" align="center">
                {p.title}
              </Text>
              <Text variant="caption" tone="muted">
                {SEVERITY_INFO[p.severity].label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <TextField
        label="Details (optional)"
        value={details}
        onChangeText={setDetails}
        maxLength={DETAILS_MAX}
        multiline
        hint="Where exactly, what you saw, what neighbours should do."
      />

      <View style={styles.section}>
        <Text variant="label">Location</Text>
        {position ? (
          <View style={styles.row} testID="quick-location">
            <Icon name="location" size={20} color="primary" />
            <Text style={styles.flex}>
              {['Your current location will be shared', accuracyLine(position.accuracy)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Button title="Remove" variant="ghost" fullWidth={false} onPress={() => setPosition(null)} />
          </View>
        ) : (
          <Button
            title="Share my current location"
            icon="location-outline"
            variant="secondary"
            loading={locating}
            onPress={() => void shareLocation()}
          />
        )}
      </View>

      <View style={styles.section}>
        <Text variant="label">Photo</Text>
        {photo ? (
          <View style={styles.row}>
            <Image
              source={{ uri: photo.uri }}
              style={styles.preview}
              accessibilityRole="image"
              accessibilityLabel="Photo to send with the alert"
              testID="quick-photo"
            />
            <Button title="Remove photo" variant="ghost" fullWidth={false} onPress={() => setPhoto(null)} />
          </View>
        ) : (
          <View style={styles.row}>
            <Button
              title="Take photo"
              icon="camera-outline"
              variant="secondary"
              fullWidth={false}
              onPress={() => void addPhoto('camera')}
            />
            <Button
              title="Choose photo"
              icon="image-outline"
              variant="ghost"
              fullWidth={false}
              onPress={() => void addPhoto('library')}
            />
          </View>
        )}
      </View>

      {preset ? (
        <Text tone="muted" testID="quick-reach">
          {reachLine(preset.severity, community.name)}
        </Text>
      ) : null}
      <Button
        title={
          preset
            ? `Send ${SEVERITY_INFO[preset.severity].label.toLowerCase()} alert now`
            : 'Choose what is happening'
        }
        variant="danger"
        icon="megaphone-outline"
        disabled={!preset}
        loading={sending}
        onPress={() => void send()}
        accessibilityLabel="Send alert now"
      />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  tile: {
    width: '47%',
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.xxs,
    padding: t.spacing.sm,
    borderRadius: t.radius.lg,
    borderWidth: 2,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  section: { gap: t.spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
  flex: { flex: 1 },
  preview: { width: 96, height: 96, borderRadius: t.radius.md },
}));

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Community, CommunityImageKind, CommunityType } from '@communione/services';
import { useCallback, useState } from 'react';
import { Image, View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { CommunityLogo } from '@/features/communities/components/CommunityLogo';
import { useCommunity, useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { TypePicker } from '@/features/communities/create/TypePicker';
import {
  deviceTimeZone,
  validateCreateCommunity,
  type CreateCommunityErrors,
} from '@/features/communities/create/validation';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useDependencies } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';

type Props = NativeStackScreenProps<CommunityStackParamList, 'EditCommunity'>;

/**
 * Edits the current community's profile: name, description, type, time
 * zone, logo and cover. Needs community.update (Owners and Admins by
 * default). The address (slug) and status are never editable here, and the
 * database refuses every change from anyone without the permission.
 */
export function EditCommunityScreen(props: Props) {
  const { services } = useDependencies();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const load = useCallback(
    () => services.communities.get(community.community_id),
    [services, community.community_id],
  );
  const details = useAsync(load);

  if (!permissions.ready || details.status === 'loading') return <LoadingState label="Loading…" />;
  if (!permissions.can('community.update')) {
    return (
      <ErrorState
        title="You can't edit this community"
        message="Only members with permission to manage the community can change its profile."
      />
    );
  }
  if (details.status === 'error') {
    return (
      <ErrorState
        title="The community could not be loaded"
        message={errorMessage(details.error)}
        onRetry={details.reload}
      />
    );
  }
  return <Form {...props} initial={details.data} />;
}

function Form({ navigation, initial }: Props & { initial: Community }) {
  const styles = useStyles();
  const { services, media } = useDependencies();
  const { communities } = services;
  const { refresh } = useCurrentCommunity();
  const [community, setCommunity] = useState(initial);
  const [form, setForm] = useState({
    name: initial.name,
    description: initial.description ?? '',
    type: initial.community_type as CommunityType,
    timezone: initial.timezone,
  });
  const [errors, setErrors] = useState<CreateCommunityErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState<CommunityImageKind | null>(null);

  const changed =
    form.name.trim() !== initial.name ||
    form.description.trim() !== (initial.description ?? '') ||
    form.type !== initial.community_type ||
    form.timezone.trim() !== initial.timezone;

  const save = async () => {
    const found = validateCreateCommunity(form);
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await communities.update(community.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        type: form.type,
        timezone: form.timezone.trim(),
      });
      // The name and type also show in the switcher and the tabs.
      await refresh();
      navigation.goBack();
    } catch (thrown) {
      setProblem(errorMessage(thrown));
      setSaving(false);
    }
  };

  const changeImage = async (kind: CommunityImageKind) => {
    setProblem(null);
    try {
      const picked = await media.pickImage(kind);
      if (!picked) return;
      setImageBusy(kind);
      setCommunity(
        await communities.uploadImage(community.id, kind, { file: picked.bytes, mimeType: picked.mimeType }),
      );
      await refresh();
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    } finally {
      setImageBusy(null);
    }
  };

  const removeImage = async (kind: CommunityImageKind) => {
    setProblem(null);
    setImageBusy(kind);
    try {
      setCommunity(await communities.removeImage(community.id, kind));
      await refresh();
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    } finally {
      setImageBusy(null);
    }
  };

  const cover = communities.imageUrl(community, 'cover');
  const hasLogo = !!(community.logo_path || community.logo_url);
  return (
    <Screen testID="edit-community-screen">
      {problem ? <Banner tone="danger" message={problem} testID="edit-community-error" /> : null}

      {cover ? (
        <Image
          source={{ uri: cover }}
          style={styles.cover}
          accessibilityRole="image"
          accessibilityLabel="Cover image"
          testID="edit-cover"
        />
      ) : null}
      <View style={styles.images}>
        <CommunityLogo community={community} size={64} />
        <View style={styles.imageButtons}>
          <Button
            title={hasLogo ? 'Change logo' : 'Add logo'}
            variant="secondary"
            fullWidth={false}
            loading={imageBusy === 'logo'}
            onPress={() => void changeImage('logo')}
          />
          {hasLogo ? (
            <Button
              title="Remove logo"
              variant="ghost"
              fullWidth={false}
              onPress={() => void removeImage('logo')}
            />
          ) : null}
          <Button
            title={cover ? 'Change cover image' : 'Add cover image'}
            variant="secondary"
            fullWidth={false}
            loading={imageBusy === 'cover'}
            onPress={() => void changeImage('cover')}
          />
          {cover ? (
            <Button
              title="Remove cover image"
              variant="ghost"
              fullWidth={false}
              onPress={() => void removeImage('cover')}
            />
          ) : null}
        </View>
      </View>

      <TextField
        label="Name"
        value={form.name}
        onChangeText={(name) => setForm((f) => ({ ...f, name }))}
        maxLength={120}
        error={errors.name}
      />
      <TextField
        label="Description"
        value={form.description}
        onChangeText={(description) => setForm((f) => ({ ...f, description }))}
        maxLength={2000}
        multiline
        error={errors.description}
      />
      <TypePicker
        value={form.type}
        onChange={(type) => setForm((f) => ({ ...f, type }))}
        error={errors.type}
      />
      <TextField
        label="Time zone"
        value={form.timezone}
        onChangeText={(timezone) => setForm((f) => ({ ...f, timezone }))}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={64}
        error={errors.timezone}
        hint="Events are shown in this time zone, e.g. America/Chicago."
      />
      {form.timezone.trim() !== deviceTimeZone() ? (
        <Button
          title={`Use this device's time zone (${deviceTimeZone()})`}
          variant="ghost"
          onPress={() => setForm((f) => ({ ...f, timezone: deviceTimeZone() }))}
        />
      ) : null}
      <Text variant="caption" tone="muted">
        {"The community's address cannot be changed."}
      </Text>
      <Button title="Save changes" onPress={() => void save()} loading={saving} disabled={!changed} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  cover: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceMuted,
  },
  images: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.md },
  imageButtons: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs },
}));

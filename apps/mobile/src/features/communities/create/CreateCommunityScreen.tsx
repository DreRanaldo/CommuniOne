import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Community, type CommunityImageKind } from '@communione/services';
import { useState } from 'react';
import { Image, View } from 'react-native';
import { Avatar, Banner, Button, Screen, Text, TextField } from '@/components';
import { useDependencies, useServices } from '@/lib/dependencies';
import type { PickedImage } from '@/lib/media';
import { makeStyles } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import { useCurrentCommunity } from '../CurrentCommunityProvider';
import { TypePicker } from './TypePicker';
import {
  deviceTimeZone,
  slugFor,
  validateCreateCommunity,
  type CreateCommunityErrors,
  type CreateCommunityForm,
} from './validation';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateCommunity'>;

const FIELDS = ['name', 'description', 'type', 'timezone'] as const;
/** Address (slug) collisions are retried with a new random suffix this many times. */
const SLUG_ATTEMPTS = 3;

/**
 * Creates a community through services.communities.create (the database's
 * create_community(): the caller becomes its Owner with an active membership
 * and the default roles, atomically). The app only uploads the optional logo
 * and cover afterwards (services.communities.uploadImage, which the database
 * allows only to community.update holders), then switches to the new
 * community. Nothing about ownership or roles is decided here.
 */
export function CreateCommunityScreen({ navigation }: Props) {
  const styles = useStyles();
  const { communities } = useServices();
  const { media } = useDependencies();
  const { select } = useCurrentCommunity();
  const [form, setForm] = useState<CreateCommunityForm>(() => ({
    name: '',
    description: '',
    type: 'residential',
    timezone: deviceTimeZone(),
  }));
  const [errors, setErrors] = useState<CreateCommunityErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [images, setImages] = useState<Partial<Record<CommunityImageKind, PickedImage>>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Created, but an image failed: the community exists, so offer to continue. */
  const [created, setCreated] = useState<{ community: Community; failed: CommunityImageKind[] } | null>(null);

  const set =
    <K extends keyof CreateCommunityForm>(field: K) =>
    (value: CreateCommunityForm[K]) =>
      setForm((f) => ({ ...f, [field]: value }));

  const pick = async (kind: CommunityImageKind) => {
    setImageError(null);
    try {
      const picked = await media.pickImage(kind);
      if (picked) setImages((current) => ({ ...current, [kind]: picked }));
    } catch (error) {
      setImageError(errorMessage(error));
    }
  };

  const openCommunity = async (community: Community) => {
    // The new membership is confirmed with the server before it becomes current.
    await select(community.id);
    navigation.popTo('App', { screen: 'Home' });
  };

  const createWithAddress = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await communities.create({
          name: form.name,
          slug: slugFor(form.name),
          type: form.type,
          description: form.description.trim() || undefined,
          timezone: form.timezone.trim(),
        });
      } catch (error) {
        const taken = isServiceError(error) && error.code === ErrorCode.Conflict;
        if (!taken || attempt >= SLUG_ATTEMPTS) throw error;
      }
    }
  };

  const submit = async () => {
    const found = validateCreateCommunity(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    let community: Community;
    try {
      community = await createWithAddress();
    } catch (error) {
      const field = errorField(error);
      if (field && (FIELDS as readonly string[]).includes(field)) setErrors({ [field]: errorMessage(error) });
      else setFormError(errorMessage(error));
      setSubmitting(false);
      return;
    }
    const failed: CommunityImageKind[] = [];
    for (const kind of ['logo', 'cover'] as const) {
      const image = images[kind];
      if (!image) continue;
      try {
        await communities.uploadImage(community.id, kind, { file: image.bytes, mimeType: image.mimeType });
      } catch {
        failed.push(kind);
      }
    }
    try {
      if (failed.length > 0) setCreated({ community, failed });
      else await openCommunity(community);
    } catch (error) {
      setCreated({ community, failed });
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    const what =
      created.failed.length === 2
        ? 'logo and cover image'
        : created.failed[0] === 'logo'
          ? 'logo'
          : 'cover image';
    return (
      <Screen testID="create-community-done">
        <Banner
          tone="success"
          title={`${created.community.name} is ready`}
          message={`Your community was created, but the ${what} could not be uploaded. You can add it later.`}
        />
        {formError ? <Banner tone="danger" message={formError} /> : null}
        <Button
          title={`Open ${created.community.name}`}
          onPress={() => void openCommunity(created.community)}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="create-community-screen">
      {images.cover ? (
        <Image
          source={{ uri: images.cover.uri }}
          style={styles.cover}
          accessibilityRole="image"
          accessibilityLabel="Cover image"
          testID="cover-preview"
        />
      ) : null}
      <View style={styles.logoRow}>
        <Avatar
          uri={images.logo?.uri ?? null}
          name={form.name.trim() || null}
          size={72}
          label="Community logo"
          testID="logo-preview"
        />
        <View style={styles.imageButtons}>
          <Button
            title={images.logo ? 'Change logo' : 'Add logo'}
            variant="secondary"
            icon="image-outline"
            fullWidth={false}
            onPress={() => void pick('logo')}
            disabled={submitting}
          />
          {images.logo ? (
            <Button
              title="Remove logo"
              variant="ghost"
              fullWidth={false}
              onPress={() => setImages(({ logo: _removed, ...rest }) => rest)}
              disabled={submitting}
            />
          ) : null}
          <Button
            title={images.cover ? 'Change cover image' : 'Add cover image (optional)'}
            variant="ghost"
            fullWidth={false}
            onPress={() => void pick('cover')}
            disabled={submitting}
          />
          {images.cover ? (
            <Button
              title="Remove cover image"
              variant="ghost"
              fullWidth={false}
              onPress={() => setImages(({ cover: _removed, ...rest }) => rest)}
              disabled={submitting}
            />
          ) : null}
        </View>
      </View>
      {imageError ? <Banner tone="danger" message={imageError} testID="image-error" /> : null}

      {formError ? <Banner tone="danger" message={formError} testID="create-community-error" /> : null}
      <TextField
        label="Community name"
        value={form.name}
        onChangeText={set('name')}
        autoCapitalize="words"
        error={errors.name}
      />
      <TextField
        label="Description (optional)"
        value={form.description}
        onChangeText={set('description')}
        multiline
        hint="What is this community about? Up to 2000 characters."
        error={errors.description}
      />
      <TypePicker value={form.type} onChange={set('type')} error={errors.type} />
      <TextField
        label="Time zone"
        value={form.timezone}
        onChangeText={set('timezone')}
        autoCapitalize="none"
        autoCorrect={false}
        hint="Used for events and announcements, e.g. America/Chicago."
        error={errors.timezone}
      />
      <Text variant="caption" tone="muted">
        You will be the Owner of this community and can invite members once it is created.
      </Text>
      <Button title="Create community" onPress={() => void submit()} loading={submitting} />
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={submitting} />
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
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  imageButtons: { flex: 1, alignItems: 'flex-start', gap: t.spacing.xs },
}));

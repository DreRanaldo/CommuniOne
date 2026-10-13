import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { STORY_CAPTION_MAX } from '@communione/services';
import { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Banner, Button, EmptyState, Screen, Text, TextField } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useDependencies } from '@/lib/dependencies';
import type { PickedImage } from '@/lib/media';
import { makeStyles } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { newRequestId } from '@/utils/ids';

type Props = NativeStackScreenProps<RootStackParamList, 'StoryComposer'>;

/**
 * Adds a story to the current community: one photo (re-encoded JPEG, no
 * location metadata) with an optional caption, visible to its members for 24
 * hours. The photo is uploaded to the user's own folder, then published with
 * a request id, so "Try again" never creates a second story. Leaving without
 * sharing discards the uploaded photo.
 */
export function StoryComposerScreen({ navigation }: Props) {
  const styles = useStyles();
  const { services, media } = useDependencies();
  const { stories } = services;
  const { current } = useCurrentCommunity();
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const uploaded = useRef<string | null>(null);
  const published = useRef(false);

  // Leaving without sharing: remove the uploaded photo (best effort; the purge job is the backstop).
  useEffect(
    () => () => {
      if (uploaded.current && !published.current)
        void stories.discardImage(uploaded.current).catch(() => undefined);
    },
    [stories],
  );

  if (!current) {
    return <EmptyState icon="people-outline" title="Choose a community first" />;
  }

  const choose = async () => {
    setProblem(null);
    try {
      const [picked] = await media.pickPhotos(1);
      if (!picked) return;
      if (uploaded.current) void stories.discardImage(uploaded.current).catch(() => undefined);
      uploaded.current = null;
      setPhoto(picked);
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    }
  };

  const share = async () => {
    if (!photo) return;
    setBusy(true);
    setProblem(null);
    try {
      if (!uploaded.current) {
        const { path } = await stories.uploadImage({
          communityId: current.community_id,
          file: photo.bytes,
          mimeType: photo.mimeType,
        });
        uploaded.current = path;
      }
      await stories.create({
        communityId: current.community_id,
        path: uploaded.current,
        width: photo.width ?? 1080,
        height: photo.height ?? 1920,
        caption: caption.trim() || null,
        clientRequestId: requestId,
      });
      published.current = true;
      navigation.goBack();
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="story-composer">
      <Text tone="muted">{`Shared with ${current.name} for 24 hours.`}</Text>
      {photo ? (
        <Image
          source={{ uri: photo.uri }}
          style={styles.preview}
          resizeMode="cover"
          accessibilityRole="image"
          accessibilityLabel="Story photo preview"
          testID="story-preview"
        />
      ) : null}
      <Button
        title={photo ? 'Choose another photo' : 'Choose a photo'}
        variant={photo ? 'secondary' : 'primary'}
        icon="image-outline"
        onPress={() => void choose()}
        disabled={busy}
      />
      {photo ? (
        <>
          <TextField
            label="Caption (optional)"
            value={caption}
            onChangeText={setCaption}
            maxLength={STORY_CAPTION_MAX}
          />
          {problem ? <Banner tone="danger" message={problem} testID="story-composer-error" /> : null}
          <Button title={problem ? 'Try again' : 'Share story'} onPress={() => void share()} loading={busy} />
        </>
      ) : problem ? (
        <Banner tone="danger" message={problem} testID="story-composer-error" />
      ) : null}
      <View />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  preview: {
    width: '100%',
    aspectRatio: 9 / 16,
    maxHeight: 420,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surfaceMuted,
  },
}));

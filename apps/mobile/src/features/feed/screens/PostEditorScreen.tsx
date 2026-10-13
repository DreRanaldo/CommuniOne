import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ErrorCode,
  isServiceError,
  POST_IMAGE_MAX_BYTES,
  POST_MAX_IMAGES,
  type Post,
} from '@communione/services';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useDependencies, useServices } from '@/lib/dependencies';
import type { PickedImage } from '@/lib/media';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField, errorMessage, isNetworkError } from '@/utils/errors';
import { newRequestId } from '@/utils/ids';

type Props = NativeStackScreenProps<CommunityStackParamList, 'PostEditor'>;

export const POST_MAX_LENGTH = 10_000;
/** Longest wait for the screen's opening animation before showing the photo library. */
export const PICKER_DELAY_MS = 450;

/**
 * Writes a new post (caption and up to 10 photos), or edits one's caption
 * (`postId`). The post being edited is loaded from the server.
 */
export function PostEditorScreen(props: Props) {
  const postId = props.route.params?.postId;
  const { posts } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<Post | null> => {
    if (!postId) return null;
    const post = await posts.get(postId);
    // Only posts of the current community are edited here.
    if (post.community_id !== community.community_id) throw new Error('not in this community');
    return post;
  }, [posts, postId, community.community_id]);
  const existing = useAsync(load);

  if (existing.status === 'loading') return <LoadingState label="Loading the post…" />;
  if (existing.status === 'error') {
    const notFound = !isServiceError(existing.error) || existing.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={notFound ? 'This post is not available' : 'The post could not be loaded'}
        message={notFound ? 'It may have been deleted or hidden.' : errorMessage(existing.error)}
        onRetry={notFound ? undefined : existing.reload}
      />
    );
  }
  return <PostEditor {...props} existing={existing.data} />;
}

type Photo = {
  key: string;
  image: PickedImage;
  /** Set once uploaded: reused by every retry, never uploaded twice. */
  path: string | null;
  state: 'waiting' | 'uploading' | 'uploaded' | 'failed';
};

function PostEditor({ navigation, route, existing }: Props & { existing: Post | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { posts } = useServices();
  const { media } = useDependencies();
  const community = useCommunity();
  const [body, setBody] = useState(existing?.body ?? '');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'publishing'>('idle');
  // One id for this post, whatever the number of attempts: the server turns a
  // retried publish into the same post instead of a duplicate.
  const [requestId] = useState(newRequestId);
  const photoCount = useRef(0);
  const editing = existing !== null;
  const length = [...body].length;
  const busy = phase !== 'idle';
  const failedBefore = formError !== null && !editing;

  useLayoutEffect(() => {
    navigation.setOptions({ title: editing ? 'Edit post' : 'New post' });
  }, [navigation, editing]);

  const addPhotos = useCallback(async () => {
    setNotice(null);
    const room = POST_MAX_IMAGES - photos.length;
    if (room <= 0) {
      setNotice(`A post can have at most ${POST_MAX_IMAGES} photos.`);
      return;
    }
    let picked: PickedImage[];
    try {
      picked = await media.pickPhotos(room);
    } catch {
      setNotice('Your photos could not be opened. Try again.');
      return;
    }
    const accepted = picked.filter(
      (p) => p.mimeType === 'image/jpeg' && p.bytes.byteLength <= POST_IMAGE_MAX_BYTES,
    );
    if (accepted.length < picked.length) {
      setNotice(
        `Some photos were too large (at most ${Math.round(POST_IMAGE_MAX_BYTES / 1048576)} MB each) and were left out.`,
      );
    }
    setPhotos((current) => [
      ...current,
      ...accepted.slice(0, POST_MAX_IMAGES - current.length).map((image) => ({
        key: `photo-${++photoCount.current}`,
        image,
        path: null,
        state: 'waiting' as const,
      })),
    ]);
  }, [media, photos.length]);

  // Opened from a photo button: go straight to the photo library, but only
  // once this screen has finished appearing. iOS refuses (silently) to show
  // the picker while a modal is still animating in, which left the user with
  // nothing happening.
  const openedWithPhotos = route.params?.addPhotos === true && !editing;
  const asked = useRef(false);
  useEffect(() => {
    if (!openedWithPhotos || asked.current) return undefined;
    const open = () => {
      if (asked.current) return;
      asked.current = true;
      void addPhotos();
    };
    const unsubscribe = navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) open();
    });
    // Fallback when no transition event comes (e.g. no animation).
    const timer = setTimeout(open, PICKER_DELAY_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [openedWithPhotos, addPhotos, navigation]);

  const removePhoto = (key: string) => {
    const photo = photos.find((p) => p.key === key);
    setPhotos((current) => current.filter((p) => p.key !== key));
    // An uploaded file no post will use: removed now (or later by the purge job).
    if (photo?.path) void posts.discardImage(photo.path).catch(() => undefined);
  };

  const setPhoto = (key: string, change: Partial<Photo>) =>
    setPhotos((current) => current.map((p) => (p.key === key ? { ...p, ...change } : p)));

  const save = async () => {
    setFormError(null);
    setNotice(null);
    if (!body.trim()) {
      setFieldError(photos.length > 0 ? 'Add a caption to your photos.' : 'Write something first.');
      return;
    }
    if (length > POST_MAX_LENGTH) {
      setFieldError(`Use at most ${POST_MAX_LENGTH.toLocaleString()} characters.`);
      return;
    }
    setFieldError(null);

    if (existing) {
      setPhase('publishing');
      try {
        await posts.edit(existing.id, body);
        navigation.goBack();
      } catch (error) {
        if (errorField(error) === 'body') setFieldError(errorMessage(error));
        else if (
          isServiceError(error) &&
          (error.code === ErrorCode.Forbidden || error.code === ErrorCode.NotFound)
        )
          setFormError("You can't edit this post.");
        else setFormError(errorMessage(error));
        setPhase('idle');
      }
      return;
    }

    // 1. Upload the photos not uploaded yet (one at a time, so progress is clear).
    setPhase('uploading');
    const uploaded = new Map(photos.filter((p) => p.path).map((p) => [p.key, p.path!]));
    for (const photo of photos) {
      if (uploaded.has(photo.key)) continue;
      setPhoto(photo.key, { state: 'uploading' });
      try {
        const { path } = await posts.uploadImage({
          communityId: community.community_id,
          file: photo.image.bytes,
          mimeType: photo.image.mimeType,
        });
        uploaded.set(photo.key, path);
        setPhoto(photo.key, { state: 'uploaded', path });
      } catch (error) {
        setPhoto(photo.key, { state: 'failed' });
        setFormError(
          isServiceError(error) && error.code === ErrorCode.Forbidden
            ? "You can't post photos in this community."
            : isNetworkError(error) || (isServiceError(error) && error.code === ErrorCode.ServerError)
              ? 'A photo could not be uploaded. Check your connection, then try again: your caption and photos are kept.'
              : errorMessage(error),
        );
        setPhase('idle');
        return;
      }
    }

    // 2. Create the post with its photos, in one request (the same request id on every attempt).
    setPhase('publishing');
    try {
      // The community comes from the current community; authorship from the session (server side).
      await posts.create({
        communityId: community.community_id,
        body,
        images: photos.map((p) => ({
          path: uploaded.get(p.key)!,
          width: p.image.width ?? 1080,
          height: p.image.height ?? 1080,
        })),
        clientRequestId: requestId,
      });
      navigation.goBack();
    } catch (error) {
      if (errorField(error) === 'body') setFieldError(errorMessage(error));
      else if (
        isServiceError(error) &&
        (error.code === ErrorCode.Forbidden || error.code === ErrorCode.NotFound)
      )
        setFormError("You can't post in this community.");
      else if (isNetworkError(error))
        setFormError(
          "Your post wasn't published: the connection was lost. Try again: nothing will be posted twice.",
        );
      else setFormError(errorMessage(error));
      setPhase('idle');
    }
  };

  const done = photos.filter((p) => p.state === 'uploaded').length;
  const uploading = photos.findIndex((p) => p.state === 'uploading');
  const progress =
    phase === 'uploading' && uploading >= 0
      ? `Uploading photo ${uploading + 1} of ${photos.length}…`
      : phase === 'publishing'
        ? editing
          ? 'Saving…'
          : 'Publishing…'
        : null;

  return (
    <Screen testID="post-editor-screen">
      <Text tone="muted">Posting in {community.name}</Text>
      {formError ? <Banner tone="danger" message={formError} testID="post-editor-error" /> : null}
      {notice ? <Banner message={notice} testID="post-editor-notice" /> : null}

      {!editing ? (
        <View style={styles.photos}>
          {photos.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
            >
              {photos.map((photo, i) => (
                <View key={photo.key} style={styles.thumb} testID={`composer-photo-${i}`}>
                  <Image
                    source={{ uri: photo.image.uri }}
                    style={styles.thumbImage}
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={`Photo ${i + 1} of ${photos.length}${
                      photo.state === 'uploaded'
                        ? ', uploaded'
                        : photo.state === 'failed'
                          ? ', upload failed'
                          : ''
                    }`}
                  />
                  {photo.state === 'uploading' ? (
                    <View style={styles.overlay}>
                      <ActivityIndicator color={colors.textInverse} />
                    </View>
                  ) : photo.state === 'failed' ? (
                    <View style={styles.overlay}>
                      <Icon name="alert-circle" size={24} color="textInverse" />
                    </View>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove photo ${i + 1}`}
                    onPress={() => removePhoto(photo.key)}
                    disabled={busy}
                    hitSlop={8}
                    style={styles.remove}
                  >
                    <Icon name="close" size={16} color="textInverse" />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <Button
            title={photos.length > 0 ? 'Add more photos' : 'Add photos'}
            variant="secondary"
            onPress={() => void addPhotos()}
            disabled={busy || photos.length >= POST_MAX_IMAGES}
          />
          <Text variant="caption" tone="muted">
            Up to {POST_MAX_IMAGES} photos. Only members of {community.name} can see them.
          </Text>
        </View>
      ) : null}

      <TextField
        label={editing ? 'Your post' : 'What would you like to share?'}
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus={!openedWithPhotos}
        error={fieldError}
        hint={`${length.toLocaleString()} / ${POST_MAX_LENGTH.toLocaleString()}`}
      />
      {editing && existing ? (
        <Text variant="caption" tone="muted">
          {"Photos can't be changed after posting; only the caption can be edited."}
        </Text>
      ) : null}

      {progress ? (
        <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={progress}>
          <Text variant="caption" tone="muted" testID="post-editor-progress">
            {progress}
          </Text>
          {photos.length > 0 && phase === 'uploading' ? (
            <View style={styles.track}>
              <View style={[styles.bar, { width: `${Math.round((done / photos.length) * 100)}%` }]} />
            </View>
          ) : null}
        </View>
      ) : null}

      <Button
        title={editing ? 'Save changes' : failedBefore ? 'Try again' : 'Post'}
        onPress={() => void save()}
        loading={busy}
      />
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={busy} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  photos: { gap: t.spacing.sm },
  strip: { gap: t.spacing.sm },
  thumb: {
    width: 104,
    height: 104,
    borderRadius: t.radius.md,
    overflow: 'hidden',
    backgroundColor: t.colors.surfaceMuted,
  },
  thumbImage: { width: 104, height: 104 },
  overlay: {
    ...({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.scrim,
  },
  remove: {
    position: 'absolute',
    top: t.spacing.xs,
    right: t.spacing.xs,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.scrim,
  },
  progress: { gap: t.spacing.xs },
  track: { height: 4, borderRadius: 2, backgroundColor: t.colors.surfaceMuted, overflow: 'hidden' },
  bar: { height: 4, backgroundColor: t.colors.primary },
}));

import type { PostImage } from '@communione/services';
import { useState } from 'react';
import {
  Image,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';

/** Frame shapes: from portrait 4:5 to landscape 1.91:1 (wider or taller photos are letterboxed, never cropped). */
export const MIN_ASPECT = 4 / 5;
export const MAX_ASPECT = 1.91;

/** The frame's width ÷ height for a set of photos: the first photo's shape, within the limits. */
export function frameAspect(images: Pick<PostImage, 'width' | 'height'>[]): number {
  const first = images[0];
  if (!first || first.width < 1 || first.height < 1) return 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, first.width / first.height));
}

export interface PostImageGalleryProps {
  images: PostImage[];
  /** Whose photos (for screen readers). */
  author: string;
  /** Width of the gallery; defaults to the screen width. */
  width?: number;
}

/**
 * A post's photos, full width, swiped horizontally one at a time. The frame
 * takes the first photo's shape (portrait, square or landscape); every photo
 * is shown whole inside it ("contain"), so nothing is cropped away. Photos
 * come from short-lived signed URLs; one that cannot be loaded says so.
 */
export function PostImageGallery({ images, author, width: given }: PostImageGalleryProps) {
  const styles = useStyles();
  const window = useWindowDimensions();
  const width = given ?? window.width;
  const height = Math.round(width / frameAspect(images));
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (images.length === 0) return null;

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1));
    if (page !== index) setIndex(Math.max(0, Math.min(images.length - 1, page)));
  };

  return (
    <View testID="post-gallery">
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        onScroll={onScroll}
        scrollEventThrottle={64}
        accessibilityLabel={images.length > 1 ? `${images.length} photos. Swipe to see more.` : undefined}
      >
        {images.map((image, i) => {
          const label = `Photo ${i + 1} of ${images.length}, posted by ${author}`;
          return (
            <View key={image.id} style={[styles.frame, { width, height }]}>
              {image.url && !failed[image.id] ? (
                <Image
                  source={{ uri: image.url }}
                  style={{ width, height }}
                  resizeMode="contain"
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={label}
                  onError={() => setFailed((f) => ({ ...f, [image.id]: true }))}
                  testID={`post-image-${i}`}
                />
              ) : (
                <View
                  style={styles.missing}
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={`${label}. It could not be loaded.`}
                  testID={`post-image-${i}-unavailable`}
                >
                  <Icon name="image-outline" size={32} color="textMuted" />
                  <Text variant="caption" tone="muted">
                    Photo unavailable
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
      {images.length > 1 ? (
        <>
          <View style={styles.counter} pointerEvents="none">
            <Text variant="caption" style={styles.counterText}>
              {index + 1}/{images.length}
            </Text>
          </View>
          <View style={styles.dots} pointerEvents="none" importantForAccessibility="no-hide-descendants">
            {images.map((image, i) => (
              <View key={image.id} style={[styles.dot, i === index && styles.dotActive]} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  frame: { backgroundColor: t.colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.xs },
  counter: {
    position: 'absolute',
    top: t.spacing.md,
    right: t.spacing.md,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.scrim,
  },
  counterText: { color: t.colors.textInverse },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: t.spacing.xs,
    paddingTop: t.spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: t.colors.border },
  dotActive: { backgroundColor: t.colors.primary },
}));

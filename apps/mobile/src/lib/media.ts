// Choosing images (avatar, community logo or cover; photos for a post): the system photo picker
// (no camera, no broad library permission on modern iOS/Android), cropped to
// the image's shape, then re-encoded as a JPEG at a fixed size. Re-encoding
// keeps uploads small and strips metadata such as GPS location.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

export interface PickedImage {
  bytes: Uint8Array;
  mimeType: 'image/jpeg';
  /** Local preview URI. */
  uri: string;
  /** Pixel size after re-encoding (post photos keep their own shape). */
  width?: number;
  height?: number;
}

/** Post photos keep their shape; the long edge is limited to this many pixels. */
export const POST_PHOTO_MAX_EDGE = 2048;

export type ImageKind = 'avatar' | 'logo' | 'cover';

export interface MediaPicker {
  /** Resolves null when the user cancels. */
  pickImage(kind: ImageKind): Promise<PickedImage | null>;
  /** Several photos for a post, uncropped (at most `limit`). Resolves [] when the user cancels. */
  pickPhotos(limit: number): Promise<PickedImage[]>;
}

/** Crop aspect and output size per kind (square avatars and logos, a wide cover). */
export const IMAGE_SHAPES: Record<ImageKind, { aspect: [number, number]; width: number; height: number }> = {
  avatar: { aspect: [1, 1], width: 512, height: 512 },
  logo: { aspect: [1, 1], width: 512, height: 512 },
  cover: { aspect: [16, 9], width: 1600, height: 900 },
};

export const expoMediaPicker: MediaPicker = {
  async pickImage(kind) {
    const shape = IMAGE_SHAPES[kind];
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: shape.aspect,
      quality: 1,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    const image = await ImageManipulator.manipulate(asset.uri)
      .resize({ width: shape.width, height: shape.height })
      .renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
    const bytes = new Uint8Array(await (await fetch(saved.uri)).arrayBuffer());
    return { bytes, mimeType: 'image/jpeg', uri: saved.uri };
  },

  async pickPhotos(limit) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: limit,
      orderedSelection: true,
      quality: 1,
      exif: false,
    });
    if (result.canceled) return [];
    const photos: PickedImage[] = [];
    for (const asset of result.assets.slice(0, limit)) {
      const scale = Math.min(1, POST_PHOTO_MAX_EDGE / Math.max(asset.width || 1, asset.height || 1));
      let context = ImageManipulator.manipulate(asset.uri);
      if (scale < 1)
        context = context.resize({
          width: Math.round(asset.width * scale),
          height: Math.round(asset.height * scale),
        });
      const image = await context.renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
      const bytes = new Uint8Array(await (await fetch(saved.uri)).arrayBuffer());
      photos.push({
        bytes,
        mimeType: 'image/jpeg',
        uri: saved.uri,
        width: saved.width,
        height: saved.height,
      });
    }
    return photos;
  },
};

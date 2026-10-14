// Choosing images (avatar, community logo or cover; photos for a post): the system photo picker
// (no camera, no broad library permission on modern iOS/Android), cropped to
// the image's shape, then re-encoded as a JPEG at a fixed size. Re-encoding
// keeps uploads small and strips metadata such as GPS location.
import * as DocumentPicker from 'expo-document-picker';
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

/** Base64 → bytes (Hermes has atob). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/^data:[^,]*,/, '').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads a local file (file:// or content://) into bytes with XMLHttpRequest,
 * which every React Native version supports for local URIs. (fetch(...)
 * .arrayBuffer() depends on Blob / FileReader support that some builds lack,
 * which made picked files silently fail.)
 */
export function readFileBytes(uri: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      const data = xhr.response as ArrayBuffer | null;
      if (data && data.byteLength >= 0) resolve(new Uint8Array(data));
      else reject(new Error('The file could not be read.'));
    };
    xhr.onerror = () => reject(new Error('The file could not be read.'));
    xhr.responseType = 'arraybuffer';
    xhr.open('GET', uri);
    xhr.send();
  });
}

/** Post photos keep their shape; the long edge is limited to this many pixels. */
export const POST_PHOTO_MAX_EDGE = 2048;

export type ImageKind = 'avatar' | 'logo' | 'cover';

/**
 * A file chosen with the system document picker (copied into the app's
 * cache). Its name, type and size are only hints for the UI: the server
 * decides the stored type, path and accepted size.
 */
export interface PickedFile {
  name: string;
  mimeType: string | null;
  /** Bytes, when the picker reports it. */
  size: number | null;
  uri: string;
  /** Reads the content (only after the size has been checked). */
  read(): Promise<Uint8Array>;
}

export interface MediaPicker {
  /** One file for the community's documents. Resolves null when the user cancels. */
  pickDocument(): Promise<PickedFile | null>;
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
  async pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    return {
      name: asset.name,
      mimeType: asset.mimeType ?? null,
      size: typeof asset.size === 'number' ? asset.size : null,
      uri: asset.uri,
      read: () => readFileBytes(asset.uri),
    };
  },

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
    // The re-encoded bytes come straight back as base64: no file read needed.
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
    const bytes = saved.base64 ? base64ToBytes(saved.base64) : await readFileBytes(saved.uri);
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
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
      const bytes = saved.base64 ? base64ToBytes(saved.base64) : await readFileBytes(saved.uri);
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

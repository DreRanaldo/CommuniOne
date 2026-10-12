// Choosing an avatar image: the system photo picker (no camera, no broad
// library permission on modern iOS/Android), square crop, then re-encoded as
// a 512 px JPEG. Re-encoding keeps uploads small and strips metadata such as
// GPS location from the original photo.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

export interface PickedImage {
  bytes: Uint8Array;
  mimeType: 'image/jpeg';
  /** Local preview URI. */
  uri: string;
}

export interface MediaPicker {
  /** Resolves null when the user cancels. */
  pickAvatar(): Promise<PickedImage | null>;
}

export const AVATAR_SIZE_PX = 512;

export const expoMediaPicker: MediaPicker = {
  async pickAvatar() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    const image = await ImageManipulator.manipulate(asset.uri)
      .resize({ width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX })
      .renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
    const bytes = new Uint8Array(await (await fetch(saved.uri)).arrayBuffer());
    return { bytes, mimeType: 'image/jpeg', uri: saved.uri };
  },
};

// Session storage for Supabase Auth backed by the device keychain / keystore
// (expo-secure-store), so access and refresh tokens are encrypted at rest.
//
// SecureStore values are limited in size (about 2 KB on some platforms) and a
// Supabase session can be larger, so values are split into chunks:
//   <key>.n = number of chunks, <key>.0 … <key>.(n-1) = the chunks.
import * as SecureStore from 'expo-secure-store';

export const CHUNK_SIZE = 1800;

/** SecureStore keys may contain only letters, digits, ".", "-" and "_". */
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

const options: SecureStore.SecureStoreOptions = {
  // Readable after the first unlock (needed for background token refresh), never synced to other devices.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function removeChunks(key: string): Promise<void> {
  const count = Number((await SecureStore.getItemAsync(`${key}.n`, options)) ?? '0');
  for (let i = 0; i < count; i += 1) await SecureStore.deleteItemAsync(`${key}.${i}`, options);
  await SecureStore.deleteItemAsync(`${key}.n`, options);
}

export const secureStorage = {
  async getItem(rawKey: string): Promise<string | null> {
    const key = safeKey(rawKey);
    const count = Number((await SecureStore.getItemAsync(`${key}.n`, options)) ?? 'NaN');
    if (!Number.isInteger(count) || count < 1) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`, options);
      if (part === null) return null; // incomplete write: treat as signed out
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(rawKey: string, value: string): Promise<void> {
    const key = safeKey(rawKey);
    await removeChunks(key);
    const count = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
    for (let i = 0; i < count; i += 1) {
      await SecureStore.setItemAsync(
        `${key}.${i}`,
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        options,
      );
    }
    // The count is written last, so a partial write is never read back.
    await SecureStore.setItemAsync(`${key}.n`, String(count), options);
  },

  async removeItem(rawKey: string): Promise<void> {
    await removeChunks(safeKey(rawKey));
  },
};

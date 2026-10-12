import * as SecureStore from 'expo-secure-store';
import { CHUNK_SIZE, secureStorage } from './secureStorage';

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => store.clear());

describe('secureStorage (Supabase session storage on the keychain)', () => {
  test('round-trips a small value', async () => {
    await secureStorage.setItem('sb-local-auth-token', '{"a":1}');
    expect(await secureStorage.getItem('sb-local-auth-token')).toBe('{"a":1}');
  });

  test('splits large sessions into chunks under the SecureStore size limit', async () => {
    const big = 'x'.repeat(CHUNK_SIZE * 3 + 17);
    await secureStorage.setItem('session', big);
    expect(store.get('session.n')).toBe('4');
    expect([...store.values()].every((v) => v.length <= 2048)).toBe(true);
    expect(await secureStorage.getItem('session')).toBe(big);
  });

  test('a shorter value replaces every old chunk', async () => {
    await secureStorage.setItem('session', 'y'.repeat(CHUNK_SIZE * 2 + 1));
    await secureStorage.setItem('session', 'short');
    expect([...store.keys()].sort()).toEqual(['session.0', 'session.n']);
    expect(await secureStorage.getItem('session')).toBe('short');
  });

  test('removeItem deletes everything (sign-out leaves nothing behind)', async () => {
    await secureStorage.setItem('session', 'z'.repeat(CHUNK_SIZE + 5));
    await secureStorage.removeItem('session');
    expect(store.size).toBe(0);
    expect(await secureStorage.getItem('session')).toBeNull();
  });

  test('a missing or incomplete value reads as signed out', async () => {
    expect(await secureStorage.getItem('nothing')).toBeNull();
    store.set('broken.n', '2');
    store.set('broken.0', 'half');
    expect(await secureStorage.getItem('broken')).toBeNull();
  });

  test('keys are sanitised for SecureStore', async () => {
    await secureStorage.setItem('sb:project/auth token', 'v');
    expect(await secureStorage.getItem('sb:project/auth token')).toBe('v');
  });
});

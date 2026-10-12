import { AppState } from 'react-native';
import { fakeKey } from '@/testing/keys';
import { secureStorage } from './secureStorage';
import { createSupabaseClient, manageAutoRefresh } from './supabase';

const config = {
  supabaseUrl: 'https://abcdefghij.supabase.co',
  supabaseAnonKey: fakeKey('publishable'),
};

describe('Supabase client', () => {
  test('initialises without any network request', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = createSupabaseClient(config);
    expect(client).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('uses keychain storage, persists the session and ignores URLs', () => {
    const auth = createSupabaseClient(config).auth as unknown as {
      storage: unknown;
      persistSession: boolean;
      autoRefreshToken: boolean;
      detectSessionInUrl: boolean;
    };
    expect(auth.storage).toBe(secureStorage);
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
    expect(auth.detectSessionInUrl).toBe(false);
  });

  test('token refresh runs only while the app is in the foreground', () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove } as never;
    });
    const auth = { startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn() };
    const stop = manageAutoRefresh({ auth } as never);
    listeners.forEach((l) => l('background'));
    expect(auth.stopAutoRefresh).toHaveBeenCalled();
    listeners.forEach((l) => l('active'));
    expect(auth.startAutoRefresh).toHaveBeenCalled();
    stop();
    expect(remove).toHaveBeenCalled();
  });
});

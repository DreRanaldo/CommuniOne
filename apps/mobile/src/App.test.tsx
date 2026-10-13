import { fakeKey, jwtFor } from '@/testing/keys';
import { render, screen } from '@testing-library/react-native';
import App from './App';
import * as supabaseModule from './lib/supabase';
import { fakeSupabase } from './testing/fakeSupabase';

describe('App launch', () => {
  afterEach(() => jest.restoreAllMocks());

  test('launches to the welcome screen with a valid configuration', async () => {
    const fake = fakeSupabase();
    const create = jest.spyOn(supabaseModule, 'createSupabaseClient').mockReturnValue(fake.client);
    await render(
      <App
        config={{
          ok: true,
          config: {
            supabaseUrl: 'https://x.supabase.co',
            supabaseAnonKey: fakeKey('publishable'),
          },
        }}
      />,
    );
    expect(await screen.findByText('One platform. Every community.')).toBeOnTheScreen();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a service-role key stops the app before any client exists', async () => {
    const create = jest.spyOn(supabaseModule, 'createSupabaseClient');
    const { validateConfig } = jest.requireActual<typeof import('./lib/env')>('./lib/env');
    const config = validateConfig(
      {
        EXPO_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: jwtFor('service_role'),
      },
      false,
    );
    await render(<App config={config} />);
    expect(screen.getByText('App configuration problem')).toBeOnTheScreen();
    expect(screen.getByText(/service-role key/)).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();
  });

  test('missing configuration shows what to fix', async () => {
    await render(<App config={{ ok: false, problems: ['EXPO_PUBLIC_SUPABASE_URL is not set.'] }} />);
    expect(screen.getByText(/EXPO_PUBLIC_SUPABASE_URL is not set/)).toBeOnTheScreen();
  });
});

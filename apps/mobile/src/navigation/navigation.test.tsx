import { getStateFromPath } from '@react-navigation/native';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { makeSession, sampleCommunities, TEST_PASSWORD } from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';
import { linking } from './linking';

describe('navigation', () => {
  test('shows a loading state while the stored session is restored', async () => {
    await renderApp({ neverRestore: true });
    expect(screen.getByLabelText('Starting CommuniOne…')).toBeOnTheScreen();
  });

  test('signed out: only the authentication flow is reachable', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(await screen.findByText('One platform. Every community.')).toBeOnTheScreen();
    expect(screen.queryByText('Communities')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Create an account' }));
    expect(await screen.findByTestId('sign-up-screen')).toBeOnTheScreen();
  });

  test('wrong credentials show one safe message, keep the user signed out and log no credentials', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'error').mockImplementation(capture);
    const user = userEvent.setup();
    await renderApp();
    await user.press(await screen.findByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-1');
    await user.press(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Email or password is incorrect/);
    expect(screen.getByTestId('sign-in-screen')).toBeOnTheScreen();
    expect(logged.join('\n')).toContain('service.refused');
    expect(logged.join('\n')).not.toMatch(/wrong-password-1|ada@example\.test/);
    jest.restoreAllMocks();
  });

  test('sign in → choose a community → community hub → section', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp({ communities: sampleCommunities });

    await user.press(await screen.findByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), TEST_PASSWORD);
    await user.press(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.test',
      password: TEST_PASSWORD,
    });

    // Authenticated app, two communities and none chosen yet: the list from services.communities.listMine().
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(screen.getByText('St. Mark Choir')).toBeOnTheScreen();

    // Community navigation.
    await user.press(screen.getByRole('button', { name: /^Maple Grove HOA/ }));
    expect(await openHub()).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText('Coming soon')).toBeOnTheScreen();
  });

  test('signed in: a restored session opens the app and the Join modal', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: sampleCommunities });
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    expect(await screen.findByTestId('join-community-screen')).toBeOnTheScreen();
  });

  test('profile: sign out swaps back to the authentication flow', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp({ session: makeSession(), communities: [] });
    expect(await screen.findByText('No communities yet')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: /Profile/ }));
    await user.press(await screen.findByRole('button', { name: 'Account & security' }));
    expect(await screen.findByText('ada@example.test')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(await screen.findByText('One platform. Every community.')).toBeOnTheScreen();
  });

  test('a backend failure shows a safe error state, and retry recovers', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: sampleCommunities,
      failFirstRpc: true,
    });
    expect(await screen.findByTestId('error-state')).toBeOnTheScreen();
    expect(screen.queryByText(/var\/lib/)).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(fake.rpc).toHaveBeenCalledTimes(2);
  });

  test('deep links: communione://join?token=… opens the Join modal', () => {
    const state = getStateFromPath('join?token=ci_abc', linking.config);
    expect(state?.routes[0]).toMatchObject({ name: 'JoinCommunity', params: { token: 'ci_abc' } });
    expect(getStateFromPath('profile', linking.config)?.routes[0]).toMatchObject({ name: 'App' });
  });
});

// Authentication flows through the whole app (navigation + AuthProvider +
// the REAL service layer) against a fake Supabase client.
import { act, screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { makeSession, sampleCommunities, TEST_EMAIL, TEST_PASSWORD } from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

const WELCOME = 'One Platform. Every Community.';

afterEach(() => jest.restoreAllMocks());

async function goToSignIn(user: ReturnType<typeof userEvent.setup>) {
  await user.press(await screen.findByRole('button', { name: 'Sign in' }));
  return screen.findByTestId('sign-in-screen');
}

async function fillSignIn(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.press(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
}

describe('sign up', () => {
  test('validates the form before contacting the server', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp();
    await user.press(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.press(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Enter a valid email address.')).toBeOnTheScreen();
    expect(screen.getByText('Use at least 8 characters.')).toBeOnTheScreen();
    expect(screen.getByText('The passwords do not match.')).toBeOnTheScreen();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  test('creates the account, asks to confirm by email, and never stores the password', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp();
    await user.press(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(await screen.findByLabelText('Name (optional)'), 'Ada');
    await user.type(screen.getByLabelText('Email'), TEST_EMAIL);
    await user.type(screen.getByLabelText('Password'), TEST_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), TEST_PASSWORD);
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(screen.getByText(/We sent a confirmation link to ada@example\.test/)).toBeOnTheScreen();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      options: { data: { display_name: 'Ada' }, emailRedirectTo: 'communione://auth/callback' },
    });
    const stored = [...(SecureStore as unknown as { __store: Map<string, string> }).__store.values()].join(
      '',
    );
    expect(stored).not.toContain(TEST_PASSWORD);
  });

  test('the confirmation link signs the user in', async () => {
    const { links, auth } = await renderApp({ communities: sampleCommunities });
    expect(await screen.findByText(WELCOME)).toBeOnTheScreen();
    await act(async () => links.open('communione://auth/callback?code=confirm-code'));
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('confirm-code');
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(screen.getByText('Email confirmed')).toBeOnTheScreen();
  });

  test('an expired confirmation link explains what happened and stays signed out', async () => {
    await renderApp({ initialURL: 'communione://auth/callback?code=expired-code' });
    expect(await screen.findByText('That link did not work')).toBeOnTheScreen();
    expect(screen.getByText(/invalid or has expired/)).toBeOnTheScreen();
    expect(screen.getByText(WELCOME)).toBeOnTheScreen();
  });
});

describe('sign in', () => {
  test('signs in and opens the main application', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp({ communities: sampleCommunities });
    await goToSignIn(user);
    await fillSignIn(user, TEST_EMAIL, TEST_PASSWORD);
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: TEST_EMAIL, password: TEST_PASSWORD });
  });

  test('invalid credentials: one message that does not reveal whether the account exists; password cleared', async () => {
    const user = userEvent.setup();
    await renderApp();
    await goToSignIn(user);
    await fillSignIn(user, TEST_EMAIL, 'Wrong-pass-1');
    expect(await screen.findByTestId('sign-in-error')).toHaveTextContent(
      /Email or password is incorrect, or the email address is not confirmed yet\./,
    );
    expect(screen.getByLabelText('Password')).toHaveDisplayValue('');
    expect(screen.getByTestId('sign-in-screen')).toBeOnTheScreen();
  });

  test('field errors appear before any request', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp();
    await goToSignIn(user);
    await user.press(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    expect(screen.getByText('Enter your email address.')).toBeOnTheScreen();
    expect(screen.getByText('Enter your password.')).toBeOnTheScreen();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  test('network errors are reported as connection problems, not wrong credentials', async () => {
    const user = userEvent.setup();
    await renderApp({ offline: true });
    await goToSignIn(user);
    await fillSignIn(user, TEST_EMAIL, TEST_PASSWORD);
    expect(await screen.findByTestId('sign-in-error')).toHaveTextContent(/couldn't reach CommuniOne/);
  });
});

describe('sign out', () => {
  test('returns to the auth screens with no "expired" notice and clears the session', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp({ session: makeSession(), communities: [] });
    await user.press(await screen.findByRole('button', { name: /Profile/ }));
    await user.press(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(WELCOME)).toBeOnTheScreen();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.queryByText('Your session has expired')).not.toBeOnTheScreen();
  });
});

describe('session restoration', () => {
  test('shows a loading state while the stored session is read', async () => {
    await renderApp({ neverRestore: true });
    expect(screen.getByLabelText('Starting CommuniOne…')).toBeOnTheScreen();
    expect(screen.queryByText(WELCOME)).not.toBeOnTheScreen();
  });

  test('a stored session opens the app directly and is checked with Auth', async () => {
    const { auth } = await renderApp({ session: makeSession(), communities: sampleCommunities });
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(screen.queryByText(WELCOME)).not.toBeOnTheScreen();
    await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
  });

  test('offline at start: the stored session is kept', async () => {
    const { auth } = await renderApp({
      session: makeSession(),
      communities: sampleCommunities,
      offline: true,
    });
    await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText(WELCOME)).not.toBeOnTheScreen();
  });
});

describe('expired sessions', () => {
  test('a stored session revoked on the server: back to sign-in with a notice', async () => {
    await renderApp({ session: makeSession(), communities: sampleCommunities, revoked: true });
    expect(await screen.findByText('Your session has expired')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-screen')).toBeOnTheScreen();
  });

  test('Supabase gives up on the session (refresh failed): back to sign-in with a notice', async () => {
    const fake = await renderApp({ session: makeSession(), communities: sampleCommunities });
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    await act(async () => fake.expireSession());
    expect(await screen.findByText('Your session has expired')).toBeOnTheScreen();
    expect(screen.queryByText('Maple Grove HOA')).not.toBeOnTheScreen();
  });

  test('revoked while in use: the next backend call signs out locally', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: sampleCommunities,
      failFirstRpc: true,
    });
    expect(await screen.findByTestId('error-state')).toBeOnTheScreen();
    fake.revokeSession();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Your session has expired')).toBeOnTheScreen();
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('returning to the foreground re-checks the session', async () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'change') listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fake = await renderApp({ session: makeSession(), communities: sampleCommunities });
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    await waitFor(() => expect(fake.auth.getUser).toHaveBeenCalledTimes(1));
    fake.revokeSession();
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + 120_000);
    await act(async () => listeners.forEach((l) => l('active')));
    expect(await screen.findByText('Your session has expired')).toBeOnTheScreen();
  });
});

describe('password reset', () => {
  test('requesting a reset shows the same confirmation for any address', async () => {
    const user = userEvent.setup();
    const { auth } = await renderApp();
    await goToSignIn(user);
    await user.press(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(await screen.findByLabelText('Email'), 'someone@example.test');
    await user.press(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account exists for that address/)).toBeOnTheScreen();
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('someone@example.test', {
      redirectTo: 'communione://auth/reset-password',
    });
  });

  test('a request that never left the phone is not shown as sent', async () => {
    const user = userEvent.setup();
    await renderApp({ offline: true });
    await goToSignIn(user);
    await user.press(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(await screen.findByLabelText('Email'), 'someone@example.test');
    await user.press(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent(/couldn't reach CommuniOne/);
    expect(screen.queryByText(/If an account exists/)).not.toBeOnTheScreen();
  });

  test('the reset link requires a new password before the app opens', async () => {
    const user = userEvent.setup();
    const { links, auth } = await renderApp({ communities: sampleCommunities });
    expect(await screen.findByText(WELCOME)).toBeOnTheScreen();
    await act(async () => links.open('communione://auth/reset-password?code=recovery-code'));

    expect(await screen.findByTestId('reset-password-screen')).toBeOnTheScreen();
    expect(screen.queryByText('Maple Grove HOA')).not.toBeOnTheScreen();

    await user.type(screen.getByLabelText('New password'), 'Brand-new-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-new-2');
    await user.press(screen.getByRole('button', { name: 'Save new password' }));
    expect(screen.getByText('The passwords do not match.')).toBeOnTheScreen();
    expect(auth.updateUser).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-new-1');
    await user.press(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(screen.getByText('Password updated')).toBeOnTheScreen();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'Brand-new-1' });
  });

  test('cancelling the reset signs out', async () => {
    const user = userEvent.setup();
    const { links } = await renderApp();
    await act(async () => links.open('communione://auth/reset-password?code=recovery-code'));
    await user.press(await screen.findByRole('button', { name: 'Cancel and sign out' }));
    expect(await screen.findByText(WELCOME)).toBeOnTheScreen();
  });
});

describe('protected navigation', () => {
  test('signed out: app routes are not reachable, even by deep link', async () => {
    const { links } = await renderApp({ communities: sampleCommunities });
    expect(await screen.findByText(WELCOME)).toBeOnTheScreen();
    await act(async () => links.open('communione://profile'));
    expect(screen.queryByTestId('profile-screen')).not.toBeOnTheScreen();
    expect(screen.queryByText('Maple Grove HOA')).not.toBeOnTheScreen();
  });

  test('after sign-out, signed-in screens are unmounted (no stale data)', async () => {
    const fake = await renderApp({ session: makeSession(), communities: sampleCommunities });
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
    await act(async () => fake.expireSession());
    expect(await screen.findByTestId('sign-in-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('communities-screen')).not.toBeOnTheScreen();
  });

  test('passwords are never shown unless the user reveals them', async () => {
    const user = userEvent.setup();
    await renderApp();
    await goToSignIn(user);
    const field = screen.getByLabelText('Password');
    expect(field).toHaveProp('secureTextEntry', true);
    await user.press(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveProp('secureTextEntry', false);
  });
});

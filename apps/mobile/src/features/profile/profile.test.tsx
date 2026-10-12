// The profile and account screens through the whole app (navigation +
// AuthProvider + the REAL service layer) against a fake Supabase client that
// applies the backend's visibility rules: profile_private and the avatar files
// belong to their owner only.
import { fireEvent, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import {
  makeSession,
  OTHER_PHONE,
  OTHER_USER_ID,
  pickedImage,
  TEST_EMAIL,
  TEST_PASSWORD,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => jest.restoreAllMocks());

async function openProfile(options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities: [], ...options });
  await user.press(await screen.findByRole('button', { name: /Profile/ }));
  return { user, ...app };
}

async function openEdit(options: FakeOptions = {}) {
  const app = await openProfile(options);
  await app.user.press(await screen.findByRole('button', { name: 'Edit profile' }));
  await screen.findByTestId('edit-profile-screen');
  return app;
}

async function openAccount(options: FakeOptions = {}) {
  const app = await openProfile(options);
  await app.user.press(await screen.findByRole('button', { name: 'Account & security' }));
  await screen.findByTestId('account-info');
  return app;
}

async function replaceText(user: User, label: string, text: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  if (text) await user.type(field, text);
}

const avatarPath = (name = '11111111-0000-4000-8000-000000000001') => `${TEST_USER_ID}/${name}.jpg`;

describe('profile loading', () => {
  test('shows a loading state, then the profile with the private phone number', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({ session: makeSession(), communities: [] });
    // Hold the first profile request to observe the loading state.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realFrom = fake.from.getMockImplementation()!;
    fake.from.mockImplementationOnce((table: string) => {
      const builder = realFrom(table);
      const then = builder.then.bind(builder);
      builder.then = ((resolve, reject) => gate.then(() => then(resolve, reject))) as typeof builder.then;
      return builder;
    });
    await user.press(await screen.findByRole('button', { name: /Profile/ }));
    expect(screen.getByLabelText('Loading your profile…')).toBeOnTheScreen();
    release();

    expect(await screen.findByText('Ada L.')).toBeOnTheScreen();
    expect(screen.getByText('Ada Lovelace')).toBeOnTheScreen();
    expect(screen.getByText('Analytical engines.')).toBeOnTheScreen();
    const phone = screen.getByTestId('profile-phone');
    expect(within(phone).getByText('+44 20 7946 0000')).toBeOnTheScreen();
    expect(within(phone).getByText('Private: only you can see your phone number.')).toBeOnTheScreen();
    expect(screen.getByTestId('avatar-initials')).toBeOnTheScreen();
  });

  test('an uploaded avatar is shown through a short-lived signed URL', async () => {
    const { storage } = await openProfile({ profile: { avatar_path: avatarPath() } });
    const image = await screen.findByTestId('avatar-image');
    expect(image.props.source).toEqual({ uri: expect.stringMatching(/^https:\/\/storage\.test\/avatars\//) });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(avatarPath(), 3600);
    expect(screen.getByLabelText('Profile picture of Ada L.')).toBeOnTheScreen();
  });

  test('a failure shows a safe error with retry', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({ session: makeSession(), communities: [] });
    fake.failNextQuery();
    await user.press(await screen.findByRole('button', { name: /Profile/ }));
    expect(await screen.findByText('Your profile could not be loaded')).toBeOnTheScreen();
    expect(screen.queryByText(/postgresql/)).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ada L.')).toBeOnTheScreen();
  });

  test('empty fields have friendly placeholders', async () => {
    await openProfile({
      profile: { display_name: null, first_name: null, last_name: null, bio: null },
      phone: null,
    });
    expect(await screen.findByText('Add your name')).toBeOnTheScreen();
    expect(screen.getByText('No bio yet.')).toBeOnTheScreen();
    expect(screen.getByText('Not added')).toBeOnTheScreen();
  });
});

describe('profile editing', () => {
  test('saves only the changed fields, then shows the updated profile', async () => {
    const { user, queries, profiles, phones } = await openEdit();
    expect(screen.getByLabelText('Display name')).toHaveDisplayValue('Ada L.');
    expect(screen.getByLabelText('Phone number')).toHaveDisplayValue('+44 20 7946 0000');

    await replaceText(user, 'Display name', 'Countess Ada');
    await replaceText(user, 'Bio', 'Poetical science.');
    await replaceText(user, 'Phone number', '+44 20 7000 0001');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByTestId('profile-screen')).toBeOnTheScreen();
    expect(await screen.findByText('Countess Ada')).toBeOnTheScreen();
    expect(screen.getByText('Poetical science.')).toBeOnTheScreen();
    expect(screen.getByText('+44 20 7000 0001')).toBeOnTheScreen();

    const update = queries.find((q) => q.table === 'profiles' && q.op === 'update');
    expect(update).toEqual({
      table: 'profiles',
      op: 'update',
      filters: [['id', TEST_USER_ID]],
      values: { display_name: 'Countess Ada', bio: 'Poetical science.' },
    });
    expect(profiles.get(TEST_USER_ID)?.first_name).toBe('Ada');
    expect(phones.get(TEST_USER_ID)).toBe('+44 20 7000 0001');
  });

  test('clearing a field saves null; clearing the phone removes it', async () => {
    const { user, profiles, phones } = await openEdit();
    await replaceText(user, 'Bio', '');
    await replaceText(user, 'Phone number', '');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('No bio yet.')).toBeOnTheScreen();
    expect(profiles.get(TEST_USER_ID)?.bio).toBeNull();
    expect(phones.get(TEST_USER_ID)).toBeNull();
    expect(screen.getByText('Not added')).toBeOnTheScreen();
  });

  test('saving with no changes makes no request', async () => {
    const { user, queries } = await openEdit();
    const before = queries.length;
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('profile-screen')).toBeOnTheScreen();
    expect(queries.slice(before).filter((q) => q.op !== 'select')).toEqual([]);
  });

  test('validation: field errors are shown and nothing is sent', async () => {
    const { user, queries } = await openEdit();
    // Long values are pasted rather than typed.
    await fireEvent.changeText(screen.getByLabelText('Display name'), 'x'.repeat(101));
    await fireEvent.changeText(screen.getByLabelText('Bio'), 'y'.repeat(1001));
    await replaceText(user, 'Phone number', 'call me');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getAllByText('Use at most 100 characters.')).toHaveLength(1);
    expect(screen.getByText('Use at most 1000 characters.')).toBeOnTheScreen();
    expect(screen.getByText(/Use digits, spaces and \+/)).toBeOnTheScreen();
    expect(queries.filter((q) => q.op !== 'select')).toEqual([]);
    expect(screen.getByTestId('edit-profile-screen')).toBeOnTheScreen();
  });

  test('a server failure keeps the form and shows a safe message', async () => {
    const { user, failNextQuery, profiles } = await openEdit();
    await replaceText(user, 'Display name', 'Countess Ada');
    failNextQuery();
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('edit-profile-error')).toHaveTextContent(/Something went wrong/);
    expect(screen.queryByText(/postgresql/)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Display name')).toHaveDisplayValue('Countess Ada');
    expect(profiles.get(TEST_USER_ID)?.display_name).toBe('Ada L.');
    // Retrying works.
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Countess Ada')).toBeOnTheScreen();
  });
});

describe('avatar', () => {
  test("choosing a photo uploads it to the user's own folder and sets it on the profile", async () => {
    const { user, media, storage, profiles, files } = await openEdit();
    media.next(pickedImage());
    await user.press(screen.getByRole('button', { name: 'Add photo' }));

    expect(await screen.findByTestId('avatar-image')).toHaveProp('source', {
      uri: 'file:///cache/avatar.jpg',
    });
    const [path, body, options] = storage.upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${TEST_USER_ID}/[0-9a-f-]{36}\\.jpg$`));
    expect(body).toBeInstanceOf(Uint8Array);
    expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
    expect(profiles.get(TEST_USER_ID)?.avatar_path).toBe(path);
    expect([...files]).toEqual([path]);
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeOnTheScreen();
  });

  test('replacing a photo removes the previous file', async () => {
    const { user, media, storage, files } = await openEdit({ profile: { avatar_path: avatarPath() } });
    media.next(pickedImage());
    await user.press(await screen.findByRole('button', { name: 'Change photo' }));
    await waitFor(() => expect(storage.remove).toHaveBeenCalledWith([avatarPath()]));
    expect(files.has(avatarPath())).toBe(false);
    expect(files.size).toBe(1);
  });

  test('cancelling the picker changes nothing', async () => {
    const { user, media, storage } = await openEdit();
    media.next(null);
    await user.press(screen.getByRole('button', { name: 'Add photo' }));
    await waitFor(() => expect(media.picker.pickAvatar).toHaveBeenCalled());
    expect(storage.upload).not.toHaveBeenCalled();
    expect(screen.getByTestId('avatar-initials')).toBeOnTheScreen();
  });

  test('removing the photo clears the profile first, then deletes the file', async () => {
    const { user, profiles, files } = await openEdit({ profile: { avatar_path: avatarPath() } });
    await user.press(await screen.findByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByTestId('avatar-initials')).toBeOnTheScreen();
    expect(profiles.get(TEST_USER_ID)?.avatar_path).toBeNull();
    expect(files.size).toBe(0);
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeOnTheScreen();
  });

  test('an oversized image is refused before uploading', async () => {
    const { user, media, storage } = await openEdit();
    media.next(pickedImage(2 * 1024 * 1024 + 1));
    await user.press(screen.getByRole('button', { name: 'Add photo' }));
    expect(await screen.findByTestId('avatar-error')).toHaveTextContent(
      /The image is too large \(at most 2 MB\)/,
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('an upload failure shows an error and keeps the old avatar', async () => {
    const { user, media, setOffline, profiles } = await openEdit();
    media.next(pickedImage());
    setOffline(true);
    await user.press(screen.getByRole('button', { name: 'Add photo' }));
    expect(await screen.findByTestId('avatar-error')).toBeOnTheScreen();
    expect(profiles.get(TEST_USER_ID)?.avatar_path).toBeNull();
    expect(screen.getByTestId('avatar-initials')).toBeOnTheScreen();
  });

  test('a picker failure (e.g. permission denied) is reported', async () => {
    const { user, media } = await openEdit();
    media.next(new Error('Photo library permission denied'));
    await user.press(screen.getByRole('button', { name: 'Add photo' }));
    expect(await screen.findByTestId('avatar-error')).toHaveTextContent(
      /Something went wrong\. Try again later/,
    );
  });
});

describe('phone privacy', () => {
  test('the phone number is read only through the owner-scoped table, never by another user id', async () => {
    const { queries } = await openProfile();
    await screen.findByTestId('profile-phone');
    const phoneQueries = queries.filter((q) => q.table === 'profile_private');
    expect(phoneQueries.length).toBeGreaterThan(0);
    for (const query of phoneQueries) {
      expect(query.filters.some(([, value]) => value === OTHER_USER_ID)).toBe(false);
    }
    // profiles has no phone column; the profile request never asks for one.
    expect(
      queries.filter((q) => q.table === 'profiles').every((q) => q.filters.every(([c]) => c !== 'phone')),
    ).toBe(true);
  });

  test("another member's phone number never reaches the app", async () => {
    await openEdit();
    expect(screen.queryByText(OTHER_PHONE)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Phone number')).toHaveDisplayValue('+44 20 7946 0000');
    expect(screen.getByText('Private: only you can see it.')).toBeOnTheScreen();
  });

  test('the phone number is written without a user id (the database uses the session user)', async () => {
    const { user, queries } = await openEdit();
    await replaceText(user, 'Phone number', '+1 202 555 0123');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByTestId('profile-screen');
    const upsert = queries.find((q) => q.table === 'profile_private' && q.op === 'upsert');
    expect(upsert?.values).toEqual({ phone: '+1 202 555 0123' });
  });
});

describe('account', () => {
  test('shows account information from Auth', async () => {
    await openAccount();
    const info = screen.getByTestId('account-info');
    expect(within(info).getByText(TEST_EMAIL)).toBeOnTheScreen();
    expect(within(info).getByLabelText(/^Member since: .*2026/)).toBeOnTheScreen();
    expect(within(info).getByLabelText(/^Email confirmed: .*2026/)).toBeOnTheScreen();
  });

  test('change password: validates, re-checks the current password, and never stores it', async () => {
    const { user, auth } = await openAccount();
    await user.press(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByTestId('change-password-screen');

    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'other');
    await user.press(screen.getAllByRole('button', { name: 'Change password' }).at(-1)!);
    expect(screen.getByText('Enter your current password.')).toBeOnTheScreen();
    expect(screen.getByText('Use at least 8 characters.')).toBeOnTheScreen();
    expect(screen.getByText('The passwords do not match.')).toBeOnTheScreen();
    expect(auth.updateUser).not.toHaveBeenCalled();

    await replaceText(user, 'Current password', 'Wrong-pass-9');
    await replaceText(user, 'New password', 'Brand-new-123');
    await replaceText(user, 'Confirm new password', 'Brand-new-123');
    await user.press(screen.getAllByRole('button', { name: 'Change password' }).at(-1)!);
    expect(await screen.findByText('Your current password is incorrect.')).toBeOnTheScreen();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Current password')).toHaveDisplayValue('');

    await user.type(screen.getByLabelText('Current password'), TEST_PASSWORD);
    await user.press(screen.getAllByRole('button', { name: 'Change password' }).at(-1)!);
    expect(await screen.findByTestId('password-changed')).toBeOnTheScreen();
    expect(auth.signInWithPassword).toHaveBeenLastCalledWith({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'Brand-new-123' });
    const stored = [...(SecureStore as unknown as { __store: Map<string, string> }).__store.values()].join(
      '',
    );
    expect(stored).not.toContain('Brand-new-123');
    expect(stored).not.toContain(TEST_PASSWORD);
  });

  test('sign out of all devices asks first, then revokes every session', async () => {
    const { user, auth } = await openAccount();
    await user.press(screen.getByRole('button', { name: 'Sign out of all devices' }));
    await user.press(screen.getByRole('button', { name: 'Keep me signed in' }));
    expect(auth.signOut).not.toHaveBeenCalled();
    await user.press(screen.getByRole('button', { name: 'Sign out of all devices' }));
    await user.press(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('One Platform. Every Community.')).toBeOnTheScreen();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(screen.queryByText('Your session has expired')).not.toBeOnTheScreen();
  });
});

describe('account deletion', () => {
  async function openDelete(options: FakeOptions = {}) {
    const app = await openAccount(options);
    await app.user.press(screen.getByRole('button', { name: 'Delete account…' }));
    await screen.findByTestId('delete-account-screen');
    return app;
  }

  test('explains the consequences and needs the confirmation word', async () => {
    const { user, rpc } = await openDelete();
    expect(screen.getByText('This cannot be undone.')).toBeOnTheScreen();
    expect(screen.getByText('Your sign-in, profile, photo and phone number')).toBeOnTheScreen();
    expect(screen.getByText(/shown as "Deleted User"/)).toBeOnTheScreen();
    const button = screen.getByRole('button', { name: 'Delete my account' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete it');
    expect(button).toBeDisabled();
    await user.press(button);
    expect(rpc).not.toHaveBeenCalledWith('delete_my_account');
  });

  test('deletes through the backend function only, then signs out with a notice', async () => {
    const { user, rpc, auth, from, profiles, phones } = await openDelete();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    const tableCallsBefore = from.mock.calls.length;
    await user.press(screen.getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByText('Your account has been deleted')).toBeOnTheScreen();
    // One RPC, no parameters: the database deletes the session user and nobody else.
    expect(rpc.mock.calls.filter(([name]) => name === 'delete_my_account')).toEqual([['delete_my_account']]);
    expect(from.mock.calls.length).toBe(tableCallsBefore);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(profiles.has(TEST_USER_ID)).toBe(false);
    expect(phones.has(TEST_USER_ID)).toBe(false);
    expect(profiles.has(OTHER_USER_ID)).toBe(true);
    expect(screen.queryByText('Your session has expired')).not.toBeOnTheScreen();
  });

  test('the only Owner of a community is asked to transfer it first and stays signed in', async () => {
    const { user, auth } = await openDelete({ deleteConflict: true });
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.press(screen.getByRole('button', { name: 'Delete my account' }));
    const error = await screen.findByTestId('delete-account-error');
    expect(error).toHaveTextContent(/Transfer your communities first/);
    expect(error).toHaveTextContent(/Maple Grove HOA/);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-account-screen')).toBeOnTheScreen();
  });

  test('a network failure is reported and nothing is deleted', async () => {
    const { user, setOffline, profiles } = await openDelete();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    setOffline(true);
    await user.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByTestId('delete-account-error')).toHaveTextContent(/couldn't reach CommuniOne/);
    expect(profiles.has(TEST_USER_ID)).toBe(true);
  });
});

describe('unauthorized profile access', () => {
  test('signed out, a profile link shows the sign-in flow and requests nothing', async () => {
    const { from, storage } = await renderApp({ initialURL: 'communione://profile' });
    expect(await screen.findByText('One Platform. Every Community.')).toBeOnTheScreen();
    expect(screen.queryByTestId('profile-screen')).not.toBeOnTheScreen();
    expect(from).not.toHaveBeenCalled();
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  test('every profile request is scoped to the session user', async () => {
    const { user, queries } = await openEdit();
    await replaceText(user, 'First name', 'Augusta');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Ada L.');
    const profileQueries = queries.filter((q) => q.table === 'profiles');
    expect(profileQueries.length).toBeGreaterThan(0);
    for (const query of profileQueries) expect(query.filters).toEqual([['id', TEST_USER_ID]]);
  });

  test('a session revoked elsewhere cannot change the profile', async () => {
    const { user, revokeSession, profiles } = await openEdit();
    await replaceText(user, 'Display name', 'Intruder');
    revokeSession();
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('edit-profile-error')).toHaveTextContent(
      /Your account cannot be changed right now/,
    );
    expect(profiles.get(TEST_USER_ID)?.display_name).toBe('Ada L.');
  });
});

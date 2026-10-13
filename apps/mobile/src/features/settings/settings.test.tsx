// Community settings through the whole app (REAL service layer) against a
// fake Supabase applying the database rules: per-community notification
// preferences (active members, own only), community.update for the
// community profile (Owners and Admins; slug and status never), the time
// zone check, and leaving (refused for the last member able to manage roles).
import { fireEvent, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { makeSession, pickedImage, sampleCommunities, type FakeOptions } from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // Owner
const C = choir.community_id; // Member

/** Signed in with one community, on its settings screen. */
async function openSettings(options: FakeOptions = {}, communities: unknown[] = [choir]) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities, ...options });
  await openHub();
  await user.press(screen.getByRole('button', { name: 'Community settings' }));
  await screen.findByTestId('community-settings-screen');
  await screen.findByTestId('notification-settings');
  return { user, ...app };
}

const toggle = (name: string) => screen.getByLabelText(name);

describe('member settings', () => {
  test('notification preferences: all on by default; turning one off is saved for this community', async () => {
    const { rpc, notificationSettings } = await openSettings();
    for (const name of ['Announcements', 'New events', 'Replies to you', 'Info and warning alerts']) {
      expect(toggle(name).props.value).toBe(true);
    }
    expect(screen.getByText('Urgent and emergency alerts always reach you.')).toBeOnTheScreen();
    fireEvent(toggle('Announcements'), 'valueChange', false);
    await waitFor(() => expect(notificationSettings.get(C)?.announcements).toBe(false));
    expect(rpc).toHaveBeenCalledWith(
      'set_community_notification_settings',
      expect.objectContaining({ p_community_id: C, p_announcements: false }),
    );
    expect(toggle('Announcements').props.value).toBe(false);
    expect(notificationSettings.get(M)).toBeUndefined();
  });

  test('a refused change puts the switch back and says why', async () => {
    const { failRpcOnce } = await openSettings();
    failRpcOnce('set_community_notification_settings', {
      code: '42501',
      message: 'not a member of this community',
    });
    fireEvent(toggle('New events'), 'valueChange', false);
    expect(await screen.findByTestId('settings-error')).toBeOnTheScreen();
    expect(toggle('New events').props.value).toBe(true);
  });

  test('membership: role and join date; members see no management', async () => {
    await openSettings();
    expect(screen.getByTestId('membership-info')).toHaveTextContent(/Member · Joined/);
    expect(screen.queryByRole('button', { name: 'Edit community profile' })).not.toBeOnTheScreen();
  });
});

describe('permissions', () => {
  test('members get no "Manage community" anywhere', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [choir] });
    await openHub();
    expect(screen.queryByTestId('hub-manage')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Community settings' }));
    await screen.findByTestId('notification-settings');
    expect(screen.queryByTestId('manage-community')).not.toBeOnTheScreen();
  });

  test.each(['Owner', 'Admin'])('an %s does', async (role) => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [{ ...choir, role_names: [role] }] });
    await openHub();
    expect(await screen.findByTestId('hub-manage')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Community settings' }));
    expect(await screen.findByTestId('manage-community')).toBeOnTheScreen();
  });
});

describe('community update', () => {
  test('the Owner edits name, description, type and time zone; the app shows the new name', async () => {
    const { user, communityRows } = await openSettings({}, [maple]);
    await user.press(screen.getByRole('button', { name: 'Edit community profile' }));
    await screen.findByTestId('edit-community-screen');
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Maple Grove Residents');
    await user.type(screen.getByLabelText('Description'), 'Our street, our news.');
    await user.press(screen.getByRole('radio', { name: 'Association' }));
    const zone = screen.getByLabelText('Time zone');
    await user.clear(zone);
    await user.type(zone, 'Europe/London');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByTestId('edit-community-screen')).not.toBeOnTheScreen());
    expect(communityRows.get(M)).toMatchObject({
      name: 'Maple Grove Residents',
      description: 'Our street, our news.',
      community_type: 'association',
      timezone: 'Europe/London',
    });
  });

  test('an unknown time zone is caught before saving', async () => {
    const { user, queries } = await openSettings({}, [maple]);
    await user.press(screen.getByRole('button', { name: 'Edit community profile' }));
    const zone = await screen.findByLabelText('Time zone');
    await user.clear(zone);
    await user.type(zone, 'Mars/Olympus');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Enter a time zone such as/)).toBeOnTheScreen();
    expect(queries.filter((q) => q.table === 'communities' && q.op === 'update')).toEqual([]);
  });

  test('logo: added and removed through the community-media bucket', async () => {
    const { user, media, mediaFiles, communityRows } = await openSettings({}, [maple]);
    await user.press(screen.getByRole('button', { name: 'Edit community profile' }));
    await screen.findByTestId('edit-community-screen');
    media.next(pickedImage());
    await user.press(screen.getByRole('button', { name: 'Add logo' }));
    await waitFor(() => expect(communityRows.get(M)?.logo_path).toMatch(new RegExp(`^${M}/`)));
    expect(mediaFiles.has(String(communityRows.get(M)!.logo_path))).toBe(true);
    await user.press(await screen.findByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(communityRows.get(M)?.logo_path).toBeNull());
  });
});

describe('unauthorized update', () => {
  test.each(['Member', 'Moderator'])(
    'a %s is refused by the backend, whatever the app shows',
    async (role) => {
      const view = await renderApp({
        session: makeSession(),
        communities: [{ ...choir, role_names: [role] }],
      });
      await screen.findByTestId('feed-screen');
      const { communities } = view.dependencies.services;
      await expect(communities.update(C, { name: 'Hijacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        communities.uploadImage(C, 'cover', { file: pickedImage().bytes, mimeType: 'image/jpeg' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(view.communityRows.get(C)?.name).toBe('St. Mark Choir');
    },
  );

  test('even an Owner cannot change the address or status', async () => {
    const view = await renderApp({ session: makeSession(), communities: [maple] });
    await screen.findByTestId('feed-screen');
    const { error: slug } = await view.dependencies.supabase
      .from('communities')
      .update({ slug: 'stolen' } as never)
      .eq('id', M);
    const { error: status } = await view.dependencies.supabase
      .from('communities')
      .update({ status: 'archived' } as never)
      .eq('id', M);
    expect(slug).toBeTruthy();
    expect(status).toBeTruthy();
  });
});

describe('leaving', () => {
  test('a member leaves after confirming; the community is gone and its screens close', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ session: makeSession(), communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^St\. Mark Choir/ }));
    await openHub();
    await user.press(screen.getByRole('button', { name: 'Community settings' }));
    await screen.findByTestId('notification-settings');
    await user.press(screen.getByRole('button', { name: 'Leave community' }));
    expect(screen.getByText(/Leave St\. Mark Choir\? You will lose access/)).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() =>
      expect(app.memberships().map((m) => (m as { community_id: string }).community_id)).toEqual([M]),
    );
    await waitFor(() => expect(screen.queryByTestId('community-settings-screen')).not.toBeOnTheScreen());
    // The choir's settings are no longer reachable.
    await expect(app.dependencies.services.communities.notificationSettings(C)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('"Stay" keeps the membership', async () => {
    const { user, memberships, queries } = await openSettings();
    await user.press(screen.getByRole('button', { name: 'Leave community' }));
    await user.press(screen.getByRole('button', { name: 'Stay' }));
    expect(memberships()).toHaveLength(1);
    expect(queries.filter((q) => q.table === 'memberships' && q.op === 'update')).toEqual([]);
  });

  test('the only role manager (Owner) cannot leave and is told why', async () => {
    const { user, memberships } = await openSettings({}, [maple]);
    await user.press(screen.getByRole('button', { name: 'Leave community' }));
    await user.press(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      /only one who can manage roles in Maple Grove HOA/,
    );
    expect(memberships().some((m) => (m as { community_id: string }).community_id === M)).toBe(true);
    expect(
      within(screen.getByTestId('membership-info')).getByRole('button', { name: 'Leave community' }),
    ).toBeOnTheScreen();
  });

  test('an Owner can leave once someone else can manage roles', async () => {
    const { user, memberships } = await openSettings({ otherRoleManagers: true }, [maple]);
    await user.press(screen.getByRole('button', { name: 'Leave community' }));
    await user.press(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(memberships()).toEqual([]));
  });
});

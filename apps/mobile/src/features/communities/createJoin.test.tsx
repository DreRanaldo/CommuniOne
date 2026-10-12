// Creating and joining communities through the whole app (navigation,
// AuthProvider, CurrentCommunityProvider and the REAL service layer) against
// a fake Supabase whose create_community / preview_invitation /
// redeem_invitation behave like the database functions.
import { fireEvent, screen, userEvent, within } from '@testing-library/react-native';
import {
  invitationToken,
  makeCommunity,
  makeSession,
  pickedImage,
  sampleCommunities,
  type FakeInvitation,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple] = sampleCommunities as [(typeof sampleCommunities)[number]];
const harbor = makeCommunity(30, {
  name: 'Harbor Sailing Club',
  community_type: 'club',
  description: 'Weekend regattas and lessons.',
  cover_image_path: 'cccccccc-0000-4000-8000-000000000030/11111111-1111-4111-8111-111111111111.jpg',
  logo_path: 'cccccccc-0000-4000-8000-000000000030/22222222-2222-4222-8222-222222222222.png',
});
const VALID = invitationToken(1);
const EXPIRED = invitationToken(2);
const REVOKED = invitationToken(3);
const STALE = invitationToken(4);
const UNKNOWN = invitationToken(99);
const invitations: Record<string, FakeInvitation> = {
  [VALID]: { community: harbor, memberCount: 42 },
  [EXPIRED]: { community: harbor, state: 'expired' },
  [REVOKED]: { community: harbor, state: 'revoked' },
  [STALE]: { community: harbor, state: 'stale' },
};

async function signedIn(options: FakeOptions & { initialURL?: string } = {}) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities: [], invitations, ...options });
  return { user, ...app };
}

const rpcNames = (rpc: jest.Mock) => rpc.mock.calls.map(([name]) => name as string);
/** Tables the app wrote to directly (it must never write memberships or roles itself). */
const writes = (queries: { table: string; op: string }[]) =>
  queries.filter((q) => q.op !== 'select').map((q) => `${q.table}.${q.op}`);

async function openCreate(user: User) {
  await user.press(await screen.findByRole('button', { name: 'Create a community' }));
  return screen.findByTestId('create-community-screen');
}

async function fillCreate(user: User, { name = 'Riverside Commons', description = '' } = {}) {
  await user.type(screen.getByLabelText('Community name'), name);
  if (description) await user.type(screen.getByLabelText('Description (optional)'), description);
}

describe('create community', () => {
  test('creates through create_community; the user becomes its Owner and lands in it', async () => {
    const { user, rpc, queries } = await signedIn();
    await openCreate(user);
    await fillCreate(user, { description: 'Our neighbourhood.' });
    await user.press(screen.getByRole('radio', { name: 'School' }));
    expect(screen.getByRole('radio', { name: 'School' })).toBeChecked();
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'America/Chicago');
    await user.press(screen.getByRole('button', { name: 'Create community' }));

    expect(
      await screen.findByLabelText('Switch community. Current community: Riverside Commons'),
    ).toBeOnTheScreen();
    expect(within(screen.getByTestId('community-home-screen')).getByText('School · Owner')).toBeOnTheScreen();

    const [, args] = rpc.mock.calls.find(([name]) => name === 'create_community')!;
    expect(args).toEqual({
      p_name: 'Riverside Commons',
      p_slug: expect.stringMatching(/^riverside-commons-[a-z0-9]{4}$/),
      p_community_type: 'school',
      p_description: 'Our neighbourhood.',
      p_timezone: 'America/Chicago',
    });
    // Ownership, membership and roles come from the database function only.
    expect(writes(queries)).toEqual([]);
    expect(rpcNames(rpc).filter((n) => !n.startsWith('list_') && n !== 'my_communities')).toEqual([
      'create_community',
    ]);
  });

  test("the time zone defaults to the device's", async () => {
    const { user } = await signedIn();
    await openCreate(user);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByLabelText('Time zone')).toHaveDisplayValue(zone);
  });

  test("a logo and an optional cover are uploaded to the new community's folder", async () => {
    const { user, media, rpc, communityRows, mediaFiles } = await signedIn();
    await openCreate(user);
    media.next({ ...pickedImage(), uri: 'file:///cache/logo.jpg' });
    await user.press(screen.getByRole('button', { name: 'Add logo' }));
    expect(await screen.findByTestId('logo-preview-image')).toHaveProp('source', {
      uri: 'file:///cache/logo.jpg',
    });
    media.next({ ...pickedImage(), uri: 'file:///cache/cover.jpg' });
    await user.press(screen.getByRole('button', { name: 'Add cover image (optional)' }));
    expect(await screen.findByTestId('cover-preview')).toBeOnTheScreen();
    expect(media.picker.pickImage).toHaveBeenNthCalledWith(1, 'logo');
    expect(media.picker.pickImage).toHaveBeenNthCalledWith(2, 'cover');

    await fillCreate(user);
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    await screen.findByTestId('community-home-screen');

    const created = rpc.mock.results.find((_r, i) => rpc.mock.calls[i]![0] === 'create_community')!;
    const { data } = (await created.value) as { data: { id: string } };
    const row = communityRows.get(data.id)!;
    expect(row.logo_path).toMatch(new RegExp(`^${data.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(row.cover_image_path).toMatch(new RegExp(`^${data.id}/[0-9a-f-]{36}\\.jpg$`));
    expect([...mediaFiles].sort()).toEqual([row.logo_path, row.cover_image_path].sort());
    // The hub shows the uploaded logo (public URL of the community-media bucket).
    expect(
      within(screen.getByTestId('community-home-screen')).getByTestId('community-logo-image'),
    ).toHaveProp('source', {
      uri: `https://storage.test/public/community-media/${String(row.logo_path)}`,
    });
  });

  test('validation: errors are shown and nothing is sent', async () => {
    const { user, rpc } = await signedIn();
    await openCreate(user);
    await fireEvent.changeText(screen.getByLabelText('Description (optional)'), 'x'.repeat(2001));
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'Not/A_Zone');
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    expect(screen.getByText('Enter a name for your community.')).toBeOnTheScreen();
    expect(screen.getByText('Use at most 2000 characters.')).toBeOnTheScreen();
    expect(screen.getByText('Enter a time zone such as America/Chicago or Europe/London.')).toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('create_community');

    await fireEvent.changeText(screen.getByLabelText('Community name'), 'x'.repeat(121));
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    expect(screen.getByText('Use at most 120 characters.')).toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('create_community');
  });

  test('an address that is taken is retried with a new one', async () => {
    const { user, rpc } = await signedIn({ slugsTaken: 1 });
    await openCreate(user);
    await fillCreate(user);
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    expect(
      await screen.findByLabelText('Switch community. Current community: Riverside Commons'),
    ).toBeOnTheScreen();
    const slugs = rpc.mock.calls
      .filter(([name]) => name === 'create_community')
      .map(([, args]) => (args as { p_slug: string }).p_slug);
    expect(slugs).toHaveLength(2);
    expect(slugs[1]).not.toBe(slugs[0]);
  });

  test('if every address is taken, the error is shown', async () => {
    const { user } = await signedIn({ slugsTaken: 5 });
    await openCreate(user);
    await fillCreate(user);
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByTestId('create-community-error')).toHaveTextContent(/already exists/);
  });

  test('the daily creation limit is explained', async () => {
    const { user } = await signedIn({ creationLimitReached: true });
    await openCreate(user);
    await fillCreate(user);
    await user.press(screen.getByRole('button', { name: 'Create community' }));
    expect(await screen.findByTestId('create-community-error')).toHaveTextContent(/creation limit reached/i);
    expect(screen.getByTestId('create-community-screen')).toBeOnTheScreen();
  });

  test('if the logo upload fails, the community still exists and the user can continue', async () => {
    const { user, media, mediaStorage, rpc } = await signedIn();
    await openCreate(user);
    media.next(pickedImage());
    await user.press(screen.getByRole('button', { name: 'Add logo' }));
    await fillCreate(user);
    mediaStorage.upload.mockResolvedValueOnce({
      data: null,
      error: { message: 'Network request failed' },
    } as never);
    await user.press(screen.getByRole('button', { name: 'Create community' }));

    const done = await screen.findByTestId('create-community-done');
    expect(within(done).getByText(/the logo could not be uploaded/)).toBeOnTheScreen();
    expect(rpcNames(rpc).filter((n) => n === 'create_community')).toHaveLength(1);
    await user.press(screen.getByRole('button', { name: 'Open Riverside Commons' }));
    expect(
      await screen.findByLabelText('Switch community. Current community: Riverside Commons'),
    ).toBeOnTheScreen();
  });
});

describe('join with an invitation', () => {
  test('a link shows the community first; accepting joins it as a Member', async () => {
    const { user, rpc, queries, redemptions } = await signedIn({
      initialURL: `communione://join?token=${VALID}`,
    });
    const preview = await screen.findByTestId('join-preview');
    expect(within(preview).getByText('Harbor Sailing Club')).toBeOnTheScreen();
    expect(within(preview).getByText('Club · 42 members')).toBeOnTheScreen();
    expect(within(preview).getByText('Weekend regattas and lessons.')).toBeOnTheScreen();
    expect(within(preview).getByTestId('invitation-cover')).toHaveProp('source', {
      uri: `https://storage.test/public/community-media/${harbor.cover_image_path}`,
    });
    expect(within(preview).getByText(/Invitation valid until/)).toBeOnTheScreen();
    // Validating consumed nothing.
    expect(redemptions).toEqual([]);
    expect(screen.queryByText(new RegExp(VALID))).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Join Harbor Sailing Club' }));
    expect(
      await screen.findByLabelText('Switch community. Current community: Harbor Sailing Club'),
    ).toBeOnTheScreen();
    expect(within(screen.getByTestId('community-home-screen')).getByText('Club · Member')).toBeOnTheScreen();
    expect(redemptions).toHaveLength(1);
    const names = rpcNames(rpc).filter((n) => !n.startsWith('list_') && n !== 'my_communities');
    expect(names).toEqual(['preview_invitation', 'redeem_invitation']);
    expect(rpc.mock.calls.find(([n]) => n === 'redeem_invitation')![1]).toEqual({ p_token: VALID });
    expect(writes(queries)).toEqual([]);
  });

  test('a code (or a pasted link) can be entered by hand', async () => {
    const { user } = await signedIn();
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    await screen.findByTestId('join-community-screen');
    await user.type(
      screen.getByLabelText('Invitation code or link'),
      `https://communione.example/join?token=${VALID}`,
    );
    await user.press(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Join Harbor Sailing Club' })).toBeOnTheScreen();
  });

  test('a malformed code is refused without contacting the server', async () => {
    const { user, rpc } = await signedIn();
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    await user.type(await screen.findByLabelText('Invitation code or link'), 'let me in');
    await user.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('This is not a valid invitation code or link.')).toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('preview_invitation');
  });

  test.each([
    ['expired', EXPIRED, 'Invitation expired'],
    ['revoked', REVOKED, 'Invitation revoked'],
    ['no longer valid', STALE, 'Invitation no longer valid'],
    ['unknown (invalid)', UNKNOWN, 'Invitation not found'],
  ])('%s invitations are refused before anything happens', async (_label, token, title) => {
    const { user, redemptions, rpc } = await signedIn({ initialURL: `communione://join?token=${token}` });
    expect(await screen.findByTestId('join-error')).toHaveTextContent(new RegExp(title));
    expect(screen.queryByText('Harbor Sailing Club')).not.toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('redeem_invitation');
    expect(redemptions).toEqual([]);
    await user.press(screen.getByRole('button', { name: 'Enter another code' }));
    expect(await screen.findByTestId('join-community-screen')).toBeOnTheScreen();
  });

  test('a link that is not an invitation at all is refused', async () => {
    const { rpc } = await signedIn({ initialURL: 'communione://join?token=not-a-token' });
    expect(await screen.findByTestId('join-error')).toHaveTextContent(/isn't a valid invitation/);
    expect(rpcNames(rpc)).not.toContain('preview_invitation');
  });

  test('already a member: told so, the invitation is not used, and the community opens', async () => {
    const member = { ...harbor, role_names: ['Member'] };
    const { user, rpc } = await signedIn({
      communities: [maple, member],
      initialURL: `communione://join?token=${VALID}`,
    });
    expect(await screen.findByTestId('already-member')).toHaveTextContent(/You're already a member/);
    expect(screen.queryByRole('button', { name: 'Join Harbor Sailing Club' })).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Open Harbor Sailing Club' }));
    expect(
      await screen.findByLabelText('Switch community. Current community: Harbor Sailing Club'),
    ).toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('redeem_invitation');
  });

  test('a suspended member cannot rejoin with an invitation', async () => {
    const suspended = { ...harbor, membership_status: 'suspended' };
    const { rpc } = await signedIn({
      communities: [maple, suspended],
      initialURL: `communione://join?token=${VALID}`,
    });
    expect(await screen.findByTestId('suspended-member')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Join Harbor Sailing Club' })).not.toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('redeem_invitation');
  });

  test('the server decides at accept time: an invitation revoked after the preview is refused', async () => {
    const {
      user,
      invitations: server,
      redemptions,
    } = await signedIn({ initialURL: `communione://join?token=${VALID}` });
    await screen.findByTestId('join-preview');
    server.set(VALID, { ...server.get(VALID)!, state: 'revoked' });
    await user.press(screen.getByRole('button', { name: 'Join Harbor Sailing Club' }));
    expect(await screen.findByTestId('join-error')).toHaveTextContent(/Invitation revoked/);
    expect(redemptions).toEqual([]);
    expect(screen.queryByTestId('community-home-screen')).not.toBeOnTheScreen();
  });

  test('a network failure while checking can be retried', async () => {
    const { user, setOffline } = await signedIn();
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    await user.type(await screen.findByLabelText('Invitation code or link'), VALID);
    setOffline(true);
    await user.press(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('join-error')).toHaveTextContent(/Couldn't check the invitation/);
    setOffline(false);
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Join Harbor Sailing Club' })).toBeOnTheScreen();
  });

  test('the code is cleared from the field once checked (not kept on screen)', async () => {
    const { user } = await signedIn();
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    await user.type(await screen.findByLabelText('Invitation code or link'), VALID);
    await user.press(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('join-preview');
    await user.press(screen.getByRole('button', { name: 'Cancel' }));
    await user.press(await screen.findByRole('button', { name: 'Join with an invitation' }));
    expect(await screen.findByLabelText('Invitation code or link')).toHaveDisplayValue('');
  });
});

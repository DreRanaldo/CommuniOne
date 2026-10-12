// The community selector through the whole app (navigation, AuthProvider,
// CurrentCommunityProvider and the REAL service layer) against a fake
// Supabase client whose my_communities() returns the user's memberships.
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { secureStorage } from '@/lib/secureStorage';
import {
  makeCommunity,
  makeSession,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';
import { CURRENT_COMMUNITY_KEY } from './CurrentCommunityProvider';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const school = makeCommunity(10, {
  name: 'Riverside Elementary PTA',
  community_type: 'school',
  role_names: ['Moderator'],
  logo_url: 'https://cdn.example.test/riverside.png',
});
const pending = makeCommunity(11, {
  name: 'Harbor Sailing Club',
  community_type: 'club',
  membership_status: 'pending',
  role_names: [],
});
const suspended = makeCommunity(12, {
  name: 'Oak Street Association',
  community_type: 'association',
  membership_status: 'suspended',
});
const archived = makeCommunity(13, {
  name: 'Old Town Choir',
  community_type: 'church',
  community_status: 'archived',
});
/** A community the user has never been a member of. */
const FOREIGN_ID = 'eeeeeeee-0000-4000-8000-000000000099';

const card = (community: { community_id: string }) =>
  screen.getByTestId(`community-card-${community.community_id}`);
const stored = async () =>
  JSON.parse((await secureStorage.getItem(CURRENT_COMMUNITY_KEY)) ?? 'null') as unknown;

async function signedIn(options: FakeOptions & { initialURL?: string } = {}) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), ...options });
  return { user, ...app };
}

/** Opens the switcher from the community hub header. */
async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.press(await screen.findByTestId('community-switcher'));
  return screen.findByTestId('communities-screen');
}

const listCalls = (rpc: jest.Mock) => rpc.mock.calls.filter(([name]) => name === 'my_communities').length;

describe('multiple communities', () => {
  test('with no current community, Home lists every membership with name, logo, type and role', async () => {
    await signedIn({ communities: [maple, choir, school, pending, suspended, archived] });
    expect(await screen.findByTestId('choose-community-screen')).toBeOnTheScreen();
    expect(screen.getByText('Your communities')).toBeOnTheScreen();

    expect(within(card(maple)).getByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(within(card(maple)).getByText('Residential · Owner')).toBeOnTheScreen();
    expect(within(card(choir)).getByText('Church · Member')).toBeOnTheScreen();
    expect(within(card(school)).getByText('School · Moderator')).toBeOnTheScreen();
    expect(within(card(school)).getByTestId('community-logo-image')).toHaveProp('source', {
      uri: 'https://cdn.example.test/riverside.png',
    });
    expect(within(card(maple)).getByTestId('community-logo-initials')).toHaveTextContent('MG');

    // Memberships that cannot be entered are listed, explained and disabled.
    expect(within(card(pending)).getByText('Waiting for approval')).toBeOnTheScreen();
    expect(within(card(suspended)).getByText('Membership suspended')).toBeOnTheScreen();
    expect(within(card(archived)).getByText('Community archived')).toBeOnTheScreen();
    for (const unavailable of [pending, suspended, archived]) expect(card(unavailable)).toBeDisabled();
    expect(card(maple)).toBeEnabled();
  });

  test('choosing one opens its hub; the header shows the current community', async () => {
    const { user } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^St\. Mark Choir/ }));
    const hub = await screen.findByTestId('community-home-screen');
    expect(within(hub).getByText('St. Mark Choir')).toBeOnTheScreen();
    expect(within(hub).getByText('Church · Member')).toBeOnTheScreen();
    expect(screen.getByLabelText('Switch community. Current community: St. Mark Choir')).toBeOnTheScreen();
    expect(await stored()).toEqual({ userId: TEST_USER_ID, communityId: choir.community_id });
  });

  test('a single community is opened directly', async () => {
    await signedIn({ communities: [maple, pending] });
    expect(await screen.findByTestId('community-home-screen')).toBeOnTheScreen();
    expect(screen.getByLabelText('Switch community. Current community: Maple Grove HOA')).toBeOnTheScreen();
  });

  test('search filters by name, type and role, ignoring case and accents', async () => {
    const cafe = makeCommunity(14, { name: 'Café Society', community_type: 'club' });
    const { user } = await signedIn({ communities: [maple, choir, school, cafe] });
    const search = await screen.findByLabelText('Search communities');

    await user.type(search, 'CAFE');
    expect(screen.getByText('Café Society')).toBeOnTheScreen();
    expect(screen.queryByText('Maple Grove HOA')).not.toBeOnTheScreen();

    await user.clear(search);
    await user.type(search, 'moderator');
    expect(screen.getByText('Riverside Elementary PTA')).toBeOnTheScreen();
    expect(screen.queryByText('St. Mark Choir')).not.toBeOnTheScreen();

    await user.clear(search);
    await user.type(search, 'church member');
    expect(screen.getByText('St. Mark Choir')).toBeOnTheScreen();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No matches')).toBeOnTheScreen();
  });

  test('no search field for a short list', async () => {
    await signedIn({ communities: [maple, choir] });
    await screen.findByTestId('choose-community-screen');
    expect(screen.queryByLabelText('Search communities')).not.toBeOnTheScreen();
  });
});

describe('switching communities', () => {
  test('switches without signing out; the switcher marks the current one and re-checks memberships', async () => {
    const { user, rpc, auth } = await signedIn({ communities: [maple, choir, school] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await screen.findByTestId('community-home-screen');

    const before = listCalls(rpc);
    await openSwitcher(user);
    await waitFor(() => expect(listCalls(rpc)).toBe(before + 1));
    expect(card(maple)).toBeSelected();
    expect(within(card(maple)).getByText('Current')).toBeOnTheScreen();
    expect(card(choir)).not.toBeSelected();
    expect(screen.getByRole('button', { name: /^Maple Grove HOA.*current community$/ })).toBeOnTheScreen();

    await user.press(card(school));
    expect(
      await screen.findByLabelText('Switch community. Current community: Riverside Elementary PTA'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('communities-screen')).not.toBeOnTheScreen();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(await stored()).toEqual({ userId: TEST_USER_ID, communityId: school.community_id });
  });

  test("switching closes the previous community's screens", async () => {
    const { user } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await user.press(await screen.findByRole('button', { name: 'Events' }));
    expect(await screen.findByText('Coming soon')).toBeOnTheScreen();

    // Back to the hub, switch: the new community opens on its hub, not on Maple Grove's section.
    await user.press(screen.getByRole('button', { name: /^Home/ }));
    await openSwitcher(user);
    await user.press(card(choir));
    const hub = await screen.findByTestId('community-home-screen');
    expect(within(hub).getByText('St. Mark Choir')).toBeOnTheScreen();
    expect(screen.queryByText('Coming soon')).not.toBeOnTheScreen();
  });

  test('tapping the current community just closes the switcher', async () => {
    const { user } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await openSwitcher(user);
    await user.press(card(maple));
    await waitFor(() => expect(screen.queryByTestId('communities-screen')).not.toBeOnTheScreen());
    expect(screen.getByLabelText('Switch community. Current community: Maple Grove HOA')).toBeOnTheScreen();
  });
});

describe('no communities', () => {
  test('shows an empty state with a way to join', async () => {
    const { user } = await signedIn({ communities: [] });
    expect(await screen.findByText('No communities yet')).toBeOnTheScreen();
    expect(screen.queryByTestId('community-home-screen')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Join with an invitation' }));
    expect(await screen.findByTestId('join-community-screen')).toBeOnTheScreen();
  });

  test('only unavailable memberships: nothing is opened', async () => {
    await signedIn({ communities: [pending, suspended] });
    expect(await screen.findByTestId('choose-community-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('community-home-screen')).not.toBeOnTheScreen();
  });

  test('a failure to load shows a safe error, and retry recovers', async () => {
    const { user } = await signedIn({ communities: [maple, choir], failFirstRpc: true });
    expect(await screen.findByText('Your communities could not be loaded')).toBeOnTheScreen();
    expect(screen.queryByText(/postgresql/)).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Maple Grove HOA')).toBeOnTheScreen();
  });
});

describe('invalid community selection', () => {
  test('an unavailable membership cannot be selected', async () => {
    const { user, rpc } = await signedIn({ communities: [maple, choir, pending] });
    await screen.findByTestId('choose-community-screen');
    const before = listCalls(rpc);
    await user.press(card(pending));
    expect(screen.getByTestId('choose-community-screen')).toBeOnTheScreen();
    expect(listCalls(rpc)).toBe(before);
    expect(await stored()).toBeNull();
  });

  test('a link to a pending membership is refused with the reason', async () => {
    await signedIn({
      communities: [maple, choir, pending],
      initialURL: `communione://communities/${pending.community_id}`,
    });
    expect(await screen.findByTestId('community-select-error')).toHaveTextContent(
      /can't open Harbor Sailing Club right now \(waiting for approval\)/,
    );
  });

  test('losing access to the current community drops it with a notice', async () => {
    const { user, setCommunities } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await screen.findByTestId('community-home-screen');

    // Removed from Maple Grove on the server; the switcher re-checks when it opens.
    setCommunities([choir]);
    await openSwitcher(user);
    expect(await screen.findByTestId('community-lost-access')).toHaveTextContent(
      /Your last community is not available/,
    );
    // The only remaining community becomes current; Maple Grove is gone from the list.
    expect(screen.queryByText('Maple Grove HOA')).not.toBeOnTheScreen();
    expect(card(choir)).toBeSelected();
    expect(await stored()).toEqual({ userId: TEST_USER_ID, communityId: choir.community_id });
  });

  test('a suspension found when the app returns to the foreground is shown by name', async () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'change') listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { user, setCommunities } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await screen.findByTestId('community-home-screen');

    setCommunities([{ ...maple, membership_status: 'suspended' }, choir]);
    now.mockReturnValue(1_000_000 + 61_000);
    await act(async () => listeners.forEach((listener) => listener('active')));

    // The only remaining community opens, and the user is told why.
    expect(await screen.findByTestId('community-lost-access')).toHaveTextContent(
      /You no longer have access to Maple Grove HOA/,
    );
    expect(screen.getByLabelText('Switch community. Current community: St. Mark Choir')).toBeOnTheScreen();
    await openSwitcher(user);
    expect(within(card(maple)).getByText('Membership suspended')).toBeOnTheScreen();
    expect(card(maple)).toBeDisabled();
  });
});

describe('unauthorized community id', () => {
  test('a link to a community the user is not a member of is refused; the current one stays', async () => {
    await secureStorage.setItem(
      CURRENT_COMMUNITY_KEY,
      JSON.stringify({ userId: TEST_USER_ID, communityId: maple.community_id }),
    );
    const { rpc } = await signedIn({
      communities: [maple, choir],
      initialURL: `communione://communities/${FOREIGN_ID}`,
    });
    // The same message whether the community exists or not (no existence leak).
    expect(await screen.findByTestId('community-select-error')).toHaveTextContent(
      /You don't have access to that community\./,
    );
    expect(listCalls(rpc)).toBeGreaterThan(0);
    expect(card(maple)).toBeSelected();
    expect(await stored()).toEqual({ userId: TEST_USER_ID, communityId: maple.community_id });
    expect(screen.queryByText(FOREIGN_ID)).not.toBeOnTheScreen();
  });

  test('a link to a member community switches after the server confirms the membership', async () => {
    const { rpc } = await signedIn({
      communities: [maple, choir],
      initialURL: `communione://communities/${choir.community_id}`,
    });
    expect(
      await screen.findByLabelText('Switch community. Current community: St. Mark Choir'),
    ).toBeOnTheScreen();
    expect(listCalls(rpc)).toBeGreaterThan(0);
  });

  test('a malformed id is refused without being sent anywhere', async () => {
    await signedIn({ communities: [maple, choir], initialURL: 'communione://communities/not-a-uuid' });
    expect(await screen.findByTestId('community-select-error')).toHaveTextContent(
      /That community link is not valid\./,
    );
  });

  test('a tampered stored id is ignored', async () => {
    await secureStorage.setItem(
      CURRENT_COMMUNITY_KEY,
      JSON.stringify({ userId: TEST_USER_ID, communityId: FOREIGN_ID }),
    );
    await signedIn({ communities: [maple, choir] });
    expect(await screen.findByTestId('community-lost-access')).toHaveTextContent(
      /Your last community is not available/,
    );
    expect(screen.getByTestId('choose-community-screen')).toBeOnTheScreen();
    expect(await stored()).toBeNull();
  });

  test('every community screen still depends on the server: a revoked session ends at sign-in', async () => {
    const { user, revokeSession } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await screen.findByTestId('community-home-screen');
    revokeSession();
    // Opening the switcher re-checks memberships; the database refuses the revoked session.
    await user.press(screen.getByTestId('community-switcher'));
    expect(await screen.findByText('Your session has expired')).toBeOnTheScreen();
    expect(screen.queryByTestId('community-home-screen')).not.toBeOnTheScreen();
  });
});

describe('state restoration', () => {
  test('the last community is reopened on the next start, after the server confirms it', async () => {
    const { user, view } = await signedIn({ communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^St\. Mark Choir/ }));
    await screen.findByTestId('community-home-screen');
    await view.unmount();

    const { rpc } = await signedIn({ communities: [maple, choir] });
    expect(
      await screen.findByLabelText('Switch community. Current community: St. Mark Choir'),
    ).toBeOnTheScreen();
    expect(listCalls(rpc)).toBe(1);
    expect(screen.queryByTestId('choose-community-screen')).not.toBeOnTheScreen();
  });

  test('a restored community that is no longer available is dropped with a notice', async () => {
    await secureStorage.setItem(
      CURRENT_COMMUNITY_KEY,
      JSON.stringify({ userId: TEST_USER_ID, communityId: choir.community_id }),
    );
    await signedIn({ communities: [maple, { ...choir, membership_status: 'pending' }, school] });
    expect(await screen.findByTestId('community-lost-access')).toHaveTextContent(
      /You no longer have access to St\. Mark Choir/,
    );
    expect(screen.getByTestId('choose-community-screen')).toBeOnTheScreen();
  });

  test("another account's selection on this device is not used", async () => {
    await secureStorage.setItem(
      CURRENT_COMMUNITY_KEY,
      JSON.stringify({ userId: 'ffffffff-0000-4000-8000-000000000001', communityId: choir.community_id }),
    );
    await signedIn({ communities: [maple, choir] });
    expect(await screen.findByTestId('choose-community-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('community-lost-access')).not.toBeOnTheScreen();
  });

  test('a corrupt stored value is ignored', async () => {
    await secureStorage.setItem(CURRENT_COMMUNITY_KEY, '{not json');
    await signedIn({ communities: [maple, choir] });
    expect(await screen.findByTestId('choose-community-screen')).toBeOnTheScreen();
  });

  test('offline at start: the stored community is not trusted without the server', async () => {
    await secureStorage.setItem(
      CURRENT_COMMUNITY_KEY,
      JSON.stringify({ userId: TEST_USER_ID, communityId: maple.community_id }),
    );
    const { setOffline, user } = await signedIn({ communities: [maple, choir], offline: true });
    expect(await screen.findByText('Your communities could not be loaded')).toBeOnTheScreen();
    expect(screen.queryByTestId('community-home-screen')).not.toBeOnTheScreen();
    setOffline(false);
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByLabelText('Switch community. Current community: Maple Grove HOA'),
    ).toBeOnTheScreen();
  });
});

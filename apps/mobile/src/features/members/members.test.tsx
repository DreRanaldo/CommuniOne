// The member directory through the whole app (REAL service layer) against a
// fake Supabase applying migration 28's rules: members.view in THIS
// community, active members with active accounts only, community-profile
// fields only (never phone, e-mail or account status), roles only with
// roles.view, name search inside the community, paging by name.
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeMember,
  makePost,
  makeSession,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id;
const C = choir.community_id; // the user is a Member here

const sarah = makeMember(1, {
  display_name: 'Sarah Anderson',
  first_name: 'Sarah',
  last_name: 'Anderson',
  bio: 'Keeps the garden going.',
  role_names: ['Moderator'],
  phone: '+1 555 0101',
});
const james = makeMember(2, {
  display_name: null,
  first_name: 'James',
  last_name: 'Park',
  phone: '+1 555 0102',
});
const pending = makeMember(3, { display_name: 'Pat Pending', status: 'pending' });
const suspended = makeMember(4, { display_name: 'Sam Suspended', status: 'suspended' });
const deactivated = makeMember(5, { display_name: 'Gone Account', profile_status: 'deactivated' });
const neighbour = makeMember(10, { display_name: 'Maple Neighbour' });

const members = () => ({
  [C]: [sarah, james, pending, suspended, deactivated].map((m) => ({ ...m })),
  [M]: [{ ...neighbour }],
});

/** Signed in (choir member), on the Members screen. */
async function openMembers(options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    members: members(),
    communityStats: { [C]: { member_count: 3 } },
    ...options,
  });
  await openHub();
  await user.press(screen.getByRole('button', { name: 'Members' }));
  await screen.findByTestId('members-screen');
  return { user, ...app };
}

const names = () =>
  within(screen.getByTestId('members-list'))
    .queryAllByTestId(/^member-/)
    .map((row) => (row.props.accessibilityLabel as string).split('. ')[0]);

const rpcResults = (rpc: jest.Mock, name: string) =>
  Promise.all(
    rpc.mock.calls.map(([n], i) => (n === name ? rpc.mock.results[i]!.value : null)).filter(Boolean),
  );

async function search(user: User, text: string) {
  const field = screen.getByLabelText('Search members by name');
  await user.clear(field);
  if (text) await user.type(field, text);
}

describe('member list', () => {
  test('active members of this community, by name, with roles, join date and "You"', async () => {
    await openMembers();
    await waitFor(() => expect(names()).toEqual(['Ada L.', 'James Park', 'Sarah Anderson']));
    expect(screen.getByTestId('members-count')).toHaveTextContent('3 members');
    // Pending, suspended, deactivated and other communities' members are not listed.
    expect(
      screen.queryByText(/Pat Pending|Sam Suspended|Gone Account|Maple Neighbour/),
    ).not.toBeOnTheScreen();
    const me = screen.getByTestId(`member-${TEST_USER_ID}`);
    expect(within(me).getByText('You')).toBeOnTheScreen();
    expect(screen.getByTestId(`member-${sarah.user_id}`).props.accessibilityLabel).toMatch(
      /^Sarah Anderson\. Moderator\. Joined June 2025$/,
    );
  });

  test('pages of 30, by name', async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      makeMember(100 + i, { display_name: `Neighbour ${String(i + 1).padStart(2, '0')}` }),
    );
    const { user, rpc } = await openMembers({ members: { [C]: many } });
    const held = () => (screen.getByTestId('members-list').props.data as unknown[]).length;
    await waitFor(() => expect(held()).toBe(30));
    await user.press(screen.getByRole('button', { name: 'Load more members' }));
    await waitFor(() => expect(held()).toBe(36));
    const last = rpc.mock.calls.filter(([n]) => n === 'list_community_members').at(-1)![1];
    expect(last).toMatchObject({ p_community_id: C, p_cursor_unnamed: false, p_cursor_name: 'neighbour 29' });
  });
});

describe('search', () => {
  test('by name, inside this community only', async () => {
    const { user, rpc } = await openMembers();
    await waitFor(() => expect(names()).toHaveLength(3));
    await search(user, 'park');
    await waitFor(() => expect(names()).toEqual(['James Park']));
    expect(rpc).toHaveBeenCalledWith(
      'list_community_members',
      expect.objectContaining({ p_community_id: C, p_query: 'park' }),
    );

    // Another community's member is not found from here.
    await search(user, 'Maple');
    expect(await screen.findByText('No members match “Maple”')).toBeOnTheScreen();
    // Phone numbers are not searchable.
    await search(user, '555');
    expect(await screen.findByText('No members match “555”')).toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(names()).toHaveLength(3));
  });
});

describe('profile', () => {
  test("a co-member's community profile: picture, name, role, joined, bio — no phone", async () => {
    const { user } = await openMembers();
    await user.press(await screen.findByTestId(`member-${sarah.user_id}`));
    await screen.findByTestId('member-profile-screen');
    expect(screen.getByTestId('member-name')).toHaveTextContent('Sarah Anderson');
    expect(within(screen.getByTestId('member-roles')).getByText('Moderator')).toBeOnTheScreen();
    expect(screen.getByText('St. Mark Choir · Joined June 2025')).toBeOnTheScreen();
    expect(within(screen.getByTestId('member-bio')).getByText('Keeps the garden going.')).toBeOnTheScreen();
    expect(screen.queryByText(/555/)).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Edit your profile' })).not.toBeOnTheScreen();
  });

  test('your own entry leads to editing your profile', async () => {
    const { user } = await openMembers();
    await user.press(await screen.findByTestId(`member-${TEST_USER_ID}`));
    await user.press(await screen.findByRole('button', { name: 'Edit your profile' }));
    expect(await screen.findByTestId('edit-profile-screen')).toBeOnTheScreen();
  });

  test("a post's author opens their member profile", async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      members: members(),
      content: {
        [C]: {
          posts: [
            makePost(C, 1, {
              author_user_id: sarah.user_id,
              author_display_name: 'Sarah Anderson',
              body: 'Garden day!',
            }),
          ],
        },
      },
    });
    await screen.findByText('Garden day!');
    await user.press(screen.getByTestId('post-author-link'));
    await screen.findByTestId('member-profile-screen');
    expect(screen.getByTestId('member-name')).toHaveTextContent('Sarah Anderson');
  });
});

describe('privacy', () => {
  test('the app never receives a phone number, e-mail or account status', async () => {
    const { user, rpc } = await openMembers();
    await waitFor(() => expect(names()).toHaveLength(3));
    await user.press(screen.getByTestId(`member-${james.user_id}`));
    await screen.findByTestId('member-profile-screen');
    const answers = JSON.stringify([
      ...(await rpcResults(rpc, 'list_community_members')),
      ...(await rpcResults(rpc, 'get_community_member')),
    ]);
    expect(answers).not.toMatch(/phone|555|email|@|profile_status|"status"/i);
  });

  test("phone numbers: another member's is not readable, even by asking the database directly", async () => {
    const { dependencies } = await openMembers();
    const { data } = await dependencies.supabase
      .from('profile_private')
      .select('phone')
      .eq('user_id', sarah.user_id);
    expect(data).toEqual([]);
    // The user's own number is still theirs to read.
    expect(await dependencies.services.auth.getMyPhone()).toBe('+44 20 7946 0000');
  });

  test('roles are left out without roles.view', async () => {
    await openMembers({ permissions: { [C]: ['community.view', 'members.view'] } });
    await waitFor(() => expect(names()).toHaveLength(3));
    expect(screen.getByTestId(`member-${sarah.user_id}`).props.accessibilityLabel).toBe(
      'Sarah Anderson. Joined June 2025',
    );
  });
});

describe('community isolation', () => {
  test('without members.view in this community, there is no directory', async () => {
    await openMembers({ permissions: { [C]: ['community.view', 'posts.view'] } });
    expect(await screen.findByText('Members could not be loaded')).toBeOnTheScreen();
    expect(screen.queryByText('Sarah Anderson')).not.toBeOnTheScreen();
  });

  test('another community’s directory and members are refused by the backend', async () => {
    const { dependencies } = await openMembers();
    const { memberships } = dependencies.services;
    await expect(memberships.directory({ communityId: M })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberships.member(M, neighbour.user_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // From this community, someone who is not an active member of it has no profile.
    await expect(memberships.member(C, neighbour.user_id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(memberships.member(C, pending.user_id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(memberships.member(C, suspended.user_id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('switching community shows the other community’s directory only', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [maple, choir], members: members() });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await openHub();
    await user.press(screen.getByRole('button', { name: 'Members' }));
    await screen.findByTestId('members-screen');
    await waitFor(() => expect(names()).toEqual(['Ada L.', 'Maple Neighbour']));
    expect(screen.queryByText('Sarah Anderson')).not.toBeOnTheScreen();
  });
});

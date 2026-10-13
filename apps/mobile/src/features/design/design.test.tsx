// The design pass through the whole app (fake Supabase): the hub's welcome
// card and section tiles with real counts (community_stats), the centre "+"
// Create sheet (actions from permissions), Discover (the user's own
// communities, join, create), the profile header with real counts
// (my_profile_stats) and the post card (community, hashtags).
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  makeAlert,
  makeDocument,
  makeEvent,
  makePost,
  makeSession,
  sampleCommunities,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';
import { lightTheme } from '@/theme';
import { splitHashtags } from '../feed/components/PostBody';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // Owner
const C = choir.community_id; // Member

async function signedIn(options: FakeOptions = {}, communities: unknown[] = [choir]) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities, ...options });
  await screen.findByTestId('feed-screen');
  return { user, ...app };
}

const tileCount = (section: string) => screen.queryByTestId(`tile-${section}-count`);

describe('community hub', () => {
  test('title, welcome card and tiles with the server’s counts', async () => {
    await signedIn({
      content: {
        [C]: {
          posts: [makePost(C, 1, { created_at: new Date().toISOString() })],
          alerts: [makeAlert(C, 1, { published_at: new Date().toISOString() })],
          events: [makeEvent(C, 2), makeEvent(C, 3)],
          documents: [makeDocument(C, 1), makeDocument(C, 2, { visibility: 'managers' })],
        },
      },
      communityStats: { [C]: { member_count: 1248 } },
    });
    await openHub();
    expect(screen.getByText('YOUR COMMUNITY')).toBeOnTheScreen();
    expect(screen.getByTestId('hub-welcome')).toHaveTextContent('Welcome home, Ada');
    await waitFor(() =>
      expect(screen.getByTestId('hub-members')).toHaveTextContent(
        '1,248 members are building a stronger community together.',
      ),
    );
    expect(tileCount('feed')).toHaveTextContent('1 new today');
    expect(tileCount('alerts')).toHaveTextContent('1 active');
    expect(tileCount('events')).toHaveTextContent('2 upcoming');
    // A member counts only what they may see (not the managers-only document).
    expect(tileCount('documents')).toHaveTextContent('1 file');
    expect(tileCount('members')).toHaveTextContent('1,248 people');
    expect(screen.getByRole('button', { name: 'Alerts' }).props.accessibilityValue).toEqual({
      text: '1 active',
    });
  });

  test('a count the user may not see is left out, never guessed', async () => {
    await signedIn({ permissions: { [C]: ['community.view', 'posts.view', 'alerts.view'] } });
    await openHub();
    await waitFor(() => expect(tileCount('alerts')).toHaveTextContent('0 active'));
    expect(tileCount('documents')).not.toBeOnTheScreen();
    expect(tileCount('events')).not.toBeOnTheScreen();
  });

  test('tiles open their sections: Documents, Members', async () => {
    const { user } = await signedIn();
    await openHub();
    await user.press(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByTestId('documents-screen')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: /^Communities/ }));
    await user.press(await screen.findByRole('button', { name: 'Members' }));
    expect(await screen.findByTestId('members-screen')).toBeOnTheScreen();
  });
});

describe('the centre + (Create)', () => {
  test('a member gets posting and story actions only, plus join and create', async () => {
    const { user } = await signedIn();
    await user.press(screen.getByRole('button', { name: 'Create' }));
    const sheet = await screen.findByTestId('create-screen');
    const actions = within(sheet)
      .getAllByRole('button')
      .map((b) => b.props.accessibilityLabel);
    expect(actions).toEqual(['Post', 'Photos', 'Story', 'Join a community', 'Create a community']);
    expect(within(sheet).getByText('In St. Mark Choir')).toBeOnTheScreen();
  });

  test('an owner gets every action; each opens its screen in the community', async () => {
    const { user } = await signedIn({}, [maple]);
    await user.press(screen.getByRole('button', { name: 'Create' }));
    const sheet = await screen.findByTestId('create-screen');
    expect(
      within(sheet)
        .getAllByRole('button')
        .map((b) => b.props.accessibilityLabel),
    ).toEqual([
      'Post',
      'Photos',
      'Story',
      'Event',
      'Alert',
      'Announcement',
      'Document',
      'Join a community',
      'Create a community',
    ]);
    await user.press(within(sheet).getByRole('button', { name: 'Event' }));
    expect(await screen.findByTestId('event-editor-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('create-screen')).not.toBeOnTheScreen();
  });

  test('Story opens the story composer', async () => {
    const { user } = await signedIn();
    await user.press(screen.getByRole('button', { name: 'Create' }));
    await user.press(await screen.findByRole('button', { name: 'Story' }));
    expect(await screen.findByTestId('story-composer')).toBeOnTheScreen();
  });
});

describe('Discover', () => {
  test('your communities, searchable; join and create; switching opens that hub', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [maple, choir] });
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
    await screen.findByTestId('feed-screen');
    await user.press(screen.getByRole('button', { name: /^Discover/ }));
    const discover = await screen.findByTestId('discover-screen');
    expect(within(discover).getByText('Discover communities')).toBeOnTheScreen();
    expect(within(discover).getByText('2 communities')).toBeOnTheScreen();
    expect(within(discover).getByTestId(`discover-${M}`)).toHaveTextContent(/Owner · Current community/);

    await user.type(within(discover).getByLabelText('Search your communities'), 'choir');
    expect(within(discover).queryByTestId(`discover-${M}`)).not.toBeOnTheScreen();
    expect(within(discover).getByTestId(`discover-${C}`)).toBeOnTheScreen();

    await user.press(within(discover).getByRole('button', { name: 'Switch to St. Mark Choir' }));
    await waitFor(() =>
      expect(screen.getByTestId('community-switcher')).toHaveTextContent(/St\. Mark Choir/),
    );
  });

  test('"Have an invitation?" opens joining by code', async () => {
    const { user } = await signedIn();
    await user.press(screen.getByRole('button', { name: /^Discover/ }));
    await user.press(await screen.findByRole('button', { name: 'Have an invitation?' }));
    expect(await screen.findByTestId('join-community-screen')).toBeOnTheScreen();
  });
});

describe('profile', () => {
  test('cover, name, role in the current community, join date and the server’s counts', async () => {
    const { user } = await signedIn({
      profileStats: { posts: 38, events_going: 12, communities: 4, member_since: '2024-03-05T12:00:00Z' },
    });
    await user.press(screen.getByRole('button', { name: /^Profile/ }));
    await screen.findByTestId('profile-screen');
    expect(screen.getByText('Ada L.')).toBeOnTheScreen();
    expect(screen.getByTestId('profile-subtitle')).toHaveTextContent('Member · St. Mark Choir');
    await waitFor(() => expect(screen.getByTestId('profile-joined')).toHaveTextContent(/Joined March 2024/));
    expect(screen.getByLabelText('38 Posts')).toBeOnTheScreen();
    expect(screen.getByLabelText('12 Events joined')).toBeOnTheScreen();
    expect(screen.getByLabelText('4 Communities')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeOnTheScreen();
  });
});

describe('post card', () => {
  test('community name and time under the author; hashtags highlighted', async () => {
    await signedIn({
      content: { [C]: { posts: [makePost(C, 1, { body: 'Thank you all! #CitadelGrows #garden_day' })] } },
    });
    const card = await screen.findByTestId(/^post-d4d4/);
    expect(within(card).getByLabelText(/^Posted .* in St\. Mark Choir$/)).toHaveTextContent(
      /^St\. Mark Choir · /,
    );
    const tag = within(card).getByText('#CitadelGrows');
    expect(StyleSheet.flatten(tag.props.style)).toMatchObject({ color: lightTheme.colors.primary });
  });

  test('splitHashtags', () => {
    expect(splitHashtags('Hi #a_b, see #Ünïcode2 and #')).toEqual([
      { text: 'Hi ', tag: false },
      { text: '#a_b', tag: true },
      { text: ', see ', tag: false },
      { text: '#Ünïcode2', tag: true },
      { text: ' and #', tag: false },
    ]);
  });
});

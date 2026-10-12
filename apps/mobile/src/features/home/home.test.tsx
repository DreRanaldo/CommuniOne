// The community home through the whole app (navigation, providers and the
// REAL service layer) against a fake Supabase whose list functions return
// content only to active members of the community asked for.
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeAlert,
  makeAnnouncement,
  makeEvent,
  makePost,
  makeSession,
  sampleCommunities,
  type FakeContent,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id;
const C = choir.community_id;

const mapleContent = (): FakeContent => ({
  alerts: [
    makeAlert(M, 1, {
      title: 'Water main break',
      body: 'Avoid Elm Street.',
      severity: 'emergency',
      severity_rank: 4,
      is_emergency: true,
    }),
    makeAlert(M, 2, { title: 'Road works', severity: 'info', severity_rank: 1 }),
  ],
  announcements: [
    makeAnnouncement(M, 1, { title: 'Annual meeting', priority: 'important' }),
    makeAnnouncement(M, 2, { title: 'Pool opens' }),
  ],
  events: [makeEvent(M, 1, { title: 'Spring clean-up', location_text: 'Clubhouse' })],
  posts: [makePost(M, 1, { body: 'Lost cat near the pond' })],
});
const choirContent = (): FakeContent => ({
  announcements: [makeAnnouncement(C, 3, { title: 'Rehearsal moved to Thursday' })],
});

const CONTENT_RPCS = [
  'list_active_alerts',
  'list_current_announcements',
  'list_upcoming_events',
  'list_community_posts',
];
const contentCalls = (rpc: jest.Mock) =>
  rpc.mock.calls
    .filter(([name]) => CONTENT_RPCS.includes(name as string))
    .map(([, args]) => args as { p_community_id: string });

/** Signed in with Maple Grove as the only community (opened directly). */
async function home(options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [maple],
    content: { [M]: mapleContent(), [C]: choirContent() },
    ...options,
  });
  // With several communities, open Maple Grove from the list first.
  if ((options.communities?.length ?? 1) > 1)
    await user.press(await screen.findByTestId(`community-card-${M}`));
  await screen.findByTestId('community-home-screen');
  return { user, ...app };
}

type Node = { props: Record<string, unknown>; children: (Node | string)[] };
const findNode = (node: Node, match: (n: Node) => boolean): Node | undefined => {
  if (match(node)) return node;
  for (const child of node.children) {
    const found = typeof child === 'string' ? undefined : findNode(child, match);
    if (found) return found;
  }
  return undefined;
};

/** Pull to refresh: calls the ScrollView's RefreshControl (passed as a prop, not rendered in tests). */
const pullToRefresh = async () => {
  const root = screen.getByTestId('community-home-screen') as unknown as Node;
  const scrollView = findNode(root, (n) => !!n.props.refreshControl)!;
  const control = scrollView.props.refreshControl as { props: { onRefresh(): void } };
  await act(async () => control.props.onRefresh());
};

describe('correct community', () => {
  test("shows the current community's identity and content, in priority order", async () => {
    const { rpc } = await home();
    const header = screen.getByTestId('community-header');
    expect(within(header).getByText('Maple Grove HOA')).toBeOnTheScreen();
    expect(within(header).getByText('Residential · Owner')).toBeOnTheScreen();

    expect(within(screen.getByTestId('home-alerts')).getByText('Water main break')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Emergency alert: Water main break/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-announcements')).getByText('Annual meeting')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-announcements')).getByText('Important')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-events')).getByText('Spring clean-up')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-events')).getByText('Clubhouse')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-posts')).getByText('Lost cat near the pond')).toBeOnTheScreen();

    // Urgent information first, community activity last (not a feed).
    const headings = screen.getAllByRole('header').map((h) => h.props.children as string);
    const order = ['Alerts', 'Announcements', 'Upcoming events', 'Recent activity', 'Explore'];
    expect(headings.filter((h) => order.includes(h))).toEqual(order);

    // Every request was for the current community.
    const calls = contentCalls(rpc);
    expect(calls).toHaveLength(4);
    expect(calls.every((args) => args.p_community_id === M)).toBe(true);
  });

  test('a summary, not a feed: a few items per section, with "See all"', async () => {
    const posts = Array.from({ length: 10 }, (_, i) => makePost(M, i + 1));
    const { rpc } = await home({ content: { [M]: { posts } } });
    expect(within(screen.getByTestId('home-posts')).getAllByText(/^Post body/)).toHaveLength(3);
    expect(rpc.mock.calls.find(([name]) => name === 'list_community_posts')![1]).toMatchObject({
      p_limit: 3,
    });
    expect(screen.getByRole('button', { name: 'See all recent activity' })).toBeOnTheScreen();
  });

  test('an item from another community is never shown', async () => {
    const content = mapleContent();
    content.announcements!.push(makeAnnouncement(C, 9, { title: 'Choir-only notice' }));
    await home({ content: { [M]: content } });
    expect(screen.getByText('Annual meeting')).toBeOnTheScreen();
    expect(screen.queryByText('Choir-only notice')).not.toBeOnTheScreen();
  });

  test("shortcuts open the community's sections", async () => {
    const { user } = await home();
    await user.press(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('Coming soon')).toBeOnTheScreen();
  });
});

describe('community switching', () => {
  test("switching shows the other community's content and none of the first", async () => {
    const { user, rpc } = await home({ communities: [maple, choir] });
    expect(screen.getByText('Water main break')).toBeOnTheScreen();

    rpc.mockClear();
    await user.press(screen.getByTestId('community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${C}`));
    expect(await screen.findByText('Rehearsal moved to Thursday')).toBeOnTheScreen();
    expect(within(screen.getByTestId('community-header')).getByText('St. Mark Choir')).toBeOnTheScreen();
    expect(screen.queryByText('Water main break')).not.toBeOnTheScreen();
    expect(screen.queryByText('Annual meeting')).not.toBeOnTheScreen();
    const calls = contentCalls(rpc);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args.p_community_id === C)).toBe(true);
  });
});

describe('states', () => {
  test("loading: shown while the community's content loads", async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { [M]: mapleContent() },
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (CONTENT_RPCS.includes(name)) await gate;
      return real(name, args);
    });
    await user.press(await screen.findByTestId(`community-card-${M}`));
    expect(await screen.findByLabelText('Loading Maple Grove HOA…')).toBeOnTheScreen();
    await act(async () => release());
    expect(await screen.findByText('Water main break')).toBeOnTheScreen();
  });

  test('empty: a quiet community says so, and keeps its shortcuts', async () => {
    await home({ content: {} });
    expect(screen.getByText("It's quiet in Maple Grove HOA")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Events' })).toBeOnTheScreen();
    expect(screen.queryByTestId('home-alerts')).not.toBeOnTheScreen();
  });

  test('empty sections are one line each', async () => {
    await home({ content: { [M]: { posts: [makePost(M, 1)] } } });
    expect(screen.getByText('No active alerts.')).toBeOnTheScreen();
    expect(screen.getByText('No current announcements.')).toBeOnTheScreen();
    expect(screen.getByText('No upcoming events.')).toBeOnTheScreen();
  });

  test('error: a failing section shows a safe message and retry; the rest stays', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { [M]: mapleContent() },
    });
    fake.failRpcOnce('list_current_announcements');
    await user.press(await screen.findByTestId(`community-card-${M}`));
    const section = await screen.findByTestId('home-announcements');
    expect(within(section).getByRole('alert')).toHaveTextContent(/Something went wrong/);
    expect(screen.queryByText(/postgresql/)).not.toBeOnTheScreen();
    expect(screen.getByText('Water main break')).toBeOnTheScreen();
    await user.press(within(section).getByRole('button', { name: 'Try loading announcements again' }));
    expect(await screen.findByText('Annual meeting')).toBeOnTheScreen();
  });

  test('error: when nothing can be loaded, one error with retry', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { [M]: mapleContent() },
    });
    for (const name of CONTENT_RPCS) fake.failRpcOnce(name);
    fake.failNextQuery();
    await user.press(await screen.findByTestId(`community-card-${M}`));
    expect(await screen.findByText('Maple Grove HOA could not be loaded')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Water main break')).toBeOnTheScreen();
  });

  test('offline at first load: an offline state with retry', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { [M]: mapleContent() },
    });
    // Hold the home's requests, go offline, then let them run.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realRpc = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (CONTENT_RPCS.includes(name)) await gate;
      return realRpc(name, args);
    });
    const realFrom = fake.from.getMockImplementation()!;
    fake.from.mockImplementation((table: string) => {
      const builder = realFrom(table);
      const then = builder.then.bind(builder);
      builder.then = ((resolve, reject) => gate.then(() => then(resolve, reject))) as typeof builder.then;
      return builder;
    });
    await user.press(await screen.findByTestId(`community-card-${M}`));
    await screen.findByLabelText('Loading Maple Grove HOA…');
    fake.setOffline(true);
    await act(async () => release());

    expect(await screen.findByText("You're offline")).toBeOnTheScreen();
    expect(screen.getByText('Check your connection and try again.')).toBeOnTheScreen();
    fake.setOffline(false);
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Water main break')).toBeOnTheScreen();
  });

  test('offline on refresh: the last content stays, marked with when it was loaded', async () => {
    const { user, setOffline } = await home();
    setOffline(true);
    await pullToRefresh();
    expect(await screen.findByTestId('home-offline')).toHaveTextContent(/Showing what was loaded at/);
    expect(screen.getByText('Water main break')).toBeOnTheScreen();

    setOffline(false);
    await user.press(
      within(screen.getByTestId('community-home-screen')).getAllByRole('button', { name: 'Try again' })[0]!,
    );
    await waitFor(() => expect(screen.queryByTestId('home-offline')).not.toBeOnTheScreen());
  });
});

describe('unauthorized community', () => {
  test('losing access while on the home: refreshing leaves the community', async () => {
    const { setCommunities } = await home({ communities: [maple, choir] });
    expect(screen.getByText('Water main break')).toBeOnTheScreen();
    setCommunities([choir]);
    await pullToRefresh();
    expect(await screen.findByTestId('community-lost-access')).toBeOnTheScreen();
    expect(screen.queryByText('Water main break')).not.toBeOnTheScreen();
  });

  test('the server returns nothing for a community the user is not active in', async () => {
    const pendingMaple = { ...maple, membership_status: 'pending' };
    await renderApp({
      session: makeSession(),
      communities: [pendingMaple, choir],
      content: { [M]: mapleContent(), [C]: choirContent() },
    });
    // Pending membership: cannot be opened at all; the choir opens.
    expect(await screen.findByText('Rehearsal moved to Thursday')).toBeOnTheScreen();
    expect(screen.queryByText('Water main break')).not.toBeOnTheScreen();
  });
});

describe('content refresh', () => {
  test('pull to refresh shows new content', async () => {
    const { content } = await home();
    content[M]!.alerts = [
      makeAlert(M, 7, { title: 'Storm warning', severity: 'urgent', severity_rank: 3 }),
      ...content[M]!.alerts!,
    ];
    expect(screen.queryByText('Storm warning')).not.toBeOnTheScreen();
    await pullToRefresh();
    expect(await screen.findByText('Storm warning')).toBeOnTheScreen();
  });

  test('coming back to the home refreshes it', async () => {
    const { user, content } = await home();
    await user.press(screen.getByRole('button', { name: 'See all upcoming events' }));
    await screen.findByText('Coming soon');
    content[M]!.events = [makeEvent(M, 5, { title: 'Summer barbecue' })];
    await user.press(screen.getByRole('button', { name: /^Home/ }));
    expect(await screen.findByText('Summer barbecue')).toBeOnTheScreen();
  });
});

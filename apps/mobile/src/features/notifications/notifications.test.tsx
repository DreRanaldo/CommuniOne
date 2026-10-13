// The notification center through the whole app (REAL service layer) against
// a fake Supabase applying the database rules: only the owner's notifications
// (private.can_read_notification, including the membership rule), newest
// first, keyset pagination, unread count, mark read / unread / all read.
// Opening one goes to its post, announcement, alert, event, community or
// document, but only if the database still lets the user see it.
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeAlert,
  makeAnnouncement,
  makeDocument,
  makeEvent,
  makeNotification,
  makePost,
  makeSession,
  OTHER_USER_ID,
  sampleCommunities,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // current community at start (the user is the Owner)
const C = choir.community_id; // the user is a Member

const post = makePost(C, 1, { body: 'Choir trip' });
const announcement = makeAnnouncement(M, 1, { title: 'Pool opens Saturday' });
const alert = makeAlert(M, 1, { title: 'Boil water' });
const event = makeEvent(C, 2, { title: 'Spring concert' });
const document = makeDocument(C, 1, { name: 'Bylaws.pdf' });

const inbox = () => [
  makeNotification(1, {
    community_id: C,
    type: 'comment',
    title: 'Grace commented on your post',
    data: { post_id: post.id, comment_id: 'e5e5e5e5-0000-4000-8000-000000000001' },
  }),
  makeNotification(2, {
    community_id: M,
    type: 'announcement',
    title: 'New announcement: Pool opens Saturday',
    data: { announcement_id: announcement.id },
  }),
  makeNotification(3, {
    community_id: M,
    type: 'alert',
    title: 'Alert: Boil water',
    data: { alert_id: alert.id },
    read_at: new Date(Date.now() - 60_000).toISOString(),
  }),
  makeNotification(4, {
    community_id: C,
    type: 'event_created',
    title: 'New event: Spring concert',
    data: { event_id: event.id },
  }),
  makeNotification(5, {
    community_id: C,
    type: 'system',
    title: 'New document: Bylaws',
    data: { document_id: document.id },
  }),
  makeNotification(6, {
    community_id: C,
    type: 'membership',
    title: 'Welcome to St. Mark Choir',
    data: { community_id: C, status: 'active' },
  }),
  makeNotification(7, { title: 'Welcome to CommuniOne', body: 'Glad you are here.' }),
];

const content = () => ({
  [M]: { announcements: [{ ...announcement }], alerts: [{ ...alert }] },
  [C]: { posts: [{ ...post }], events: [{ ...event }], documents: [{ ...document }] },
});

/** Signed in, on the feed; returns the fake backend. */
async function start(options: FakeOptions & { initialURL?: string } = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [maple, choir],
    notifications: inbox(),
    content: content(),
    ...options,
  });
  // Two communities: the user picks Maple Grove first (it becomes current).
  const active = (options.communities ?? [maple, choir]).filter(
    (c) => (c as { membership_status: string }).membership_status === 'active',
  );
  if (active.length > 1 && !options.initialURL) {
    await user.press(await screen.findByRole('button', { name: /^Maple Grove HOA/ }));
  }
  if (!options.initialURL) await screen.findByTestId('feed-notifications');
  return { user, ...app };
}

/** From the feed's bell to the notification center. */
async function openCenter(user: User) {
  await user.press(await screen.findByTestId('feed-notifications'));
  await screen.findByTestId('notifications-screen');
  return screen.findByTestId('notifications-list');
}

const row = (title: string) => screen.findByRole('button', { name: new RegExp(title) });
const rpcNames = (rpc: jest.Mock) => rpc.mock.calls.map(([name]) => name as string);

describe('notification center', () => {
  test('the bell shows the unread count; the list is the user’s own, newest first', async () => {
    const { user, rpc } = await start({
      notifications: [...inbox(), makeNotification(8, { user_id: OTHER_USER_ID, title: 'Someone else’s' })],
    });
    // 6 unread (the alert one is read; another user's never counts).
    expect(await screen.findByLabelText('Notifications, 6 unread')).toBeOnTheScreen();
    expect(within(screen.getByTestId('feed-notifications')).getByTestId('unread-badge')).toHaveTextContent(
      /^6$/,
    );

    const list = await openCenter(user);
    const titles = within(list)
      .getAllByRole('button')
      .map((b) => b.props.accessibilityLabel as string);
    expect(titles[0]).toMatch(/^Unread\. .*Grace commented on your post/);
    expect(titles[2]).not.toMatch(/^Unread/); // the read alert
    expect(titles.join('\n')).not.toMatch(/Someone else’s/);
    expect(titles).toHaveLength(7);
    expect(screen.getByRole('tab', { name: 'Unread, 6' })).toBeOnTheScreen();
    expect(within(list).getAllByTestId('notification-unread-dot')).toHaveLength(6);
    expect(rpcNames(rpc)).toContain('list_my_notifications');
  });

  test('no notifications: an empty state, no badge, nothing to mark', async () => {
    const { user } = await start({ notifications: [] });
    expect(await screen.findByLabelText('Notifications')).toBeOnTheScreen();
    expect(screen.queryByTestId('unread-badge')).not.toBeOnTheScreen();
    await openCenter(user);
    expect(await screen.findByText('No notifications yet.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  test('the badge caps at 99+', async () => {
    await start({ notifications: Array.from({ length: 120 }, (_, i) => makeNotification(i + 1)) });
    expect(await screen.findByLabelText('Notifications, 120 unread')).toBeOnTheScreen();
    expect(screen.getByTestId('unread-badge')).toHaveTextContent(/^99\+$/);
  });

  test('pagination: 20 at a time with a cursor, until the end', async () => {
    const { user, rpc } = await start({
      notifications: Array.from({ length: 45 }, (_, i) => makeNotification(i + 1)),
    });
    await openCenter(user);
    // (The list renders lazily: count what it holds.)
    const held = () => (screen.getByTestId('notifications-list').props.data as unknown[]).length;
    expect(held()).toBe(20);
    const first = rpc.mock.calls.find(([n]) => n === 'list_my_notifications')![1];
    expect(first).toMatchObject({ p_limit: 20 });
    expect(first?.p_cursor_id ?? null).toBeNull();

    await user.press(screen.getByRole('button', { name: 'Load more notifications' }));
    await waitFor(() => expect(held()).toBe(40));
    const second = rpc.mock.calls.filter(([n]) => n === 'list_my_notifications').at(-1)![1];
    const twentieth = makeNotification(20);
    expect(second).toMatchObject({ p_cursor_id: twentieth.id });

    await user.press(screen.getByRole('button', { name: 'Load more notifications' }));
    await waitFor(() => expect(held()).toBe(45));
    expect(screen.queryByRole('button', { name: 'Load more notifications' })).not.toBeOnTheScreen();
    // No duplicates across pages.
    const ids = (screen.getByTestId('notifications-list').props.data as { id: string }[]).map((n) => n.id);
    expect(new Set(ids).size).toBe(45);
  });

  test('the Unread tab asks the server for unread ones only', async () => {
    const { user, rpc } = await start();
    await openCenter(user);
    await user.press(screen.getByRole('tab', { name: 'Unread, 6' }));
    await waitFor(() => expect(screen.queryByText('Alert: Boil water')).not.toBeOnTheScreen());
    expect(rpc.mock.calls.filter(([n]) => n === 'list_my_notifications').at(-1)![1]).toMatchObject({
      p_unread_only: true,
    });
    expect(within(await screen.findByTestId('notifications-list')).getAllByRole('button')).toHaveLength(6);
  });

  test('mark all read: one call, the list and the counts update', async () => {
    const { user, rpc, notifications } = await start();
    await openCenter(user);
    await user.press(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent(
      /6 notifications marked as read\./,
    );
    await waitFor(() => expect(screen.queryAllByTestId('notification-unread-dot')).toHaveLength(0));
    expect(screen.getByRole('tab', { name: 'Unread' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
    expect(rpcNames(rpc).filter((n) => n === 'mark_all_notifications_read')).toHaveLength(1);
    expect(notifications.every((n) => n.read_at)).toBe(true);
  });

  test('a failed mark all read says so and changes nothing', async () => {
    const { user, failRpcOnce, notifications } = await start();
    await openCenter(user);
    failRpcOnce('mark_all_notifications_read');
    await user.press(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent(/./);
    expect(screen.getByTestId('notifications-notice')).not.toHaveTextContent(/postgresql/);
    expect(notifications.filter((n) => !n.read_at)).toHaveLength(6);
    expect(screen.getAllByTestId('notification-unread-dot')).toHaveLength(6);
  });
});

describe('opening a notification', () => {
  test('a comment opens its post in its community (switching to it) and marks it read', async () => {
    const { user, rpc, notifications } = await start();
    await openCenter(user);
    await user.press(await row('Grace commented on your post'));
    expect(await screen.findByTestId('post-detail-screen')).toBeOnTheScreen();
    expect(await screen.findByText('Choir trip')).toBeOnTheScreen();
    expect(notifications[0]!.read_at).not.toBeNull();
    // The community was re-checked on the server before switching.
    expect(rpcNames(rpc)).toContain('mark_notification_read');
    // The center closed into the existing tabs (no second copy of them).
    expect(screen.queryByTestId('notifications-screen')).not.toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /^Home/ })).toHaveLength(1);
    // The feed is now the choir's, and its bell no longer counts that one.
    await user.press(screen.getByRole('button', { name: /^Home/ }));
    expect(await screen.findByLabelText(/Current community: St\. Mark Choir/)).toBeOnTheScreen();
    expect(await screen.findByLabelText('Notifications, 5 unread')).toBeOnTheScreen();
  });

  test('an announcement and an alert open in the current community', async () => {
    const { user } = await start();
    await openCenter(user);
    await user.press(await row('New announcement: Pool opens Saturday'));
    expect(await screen.findByTestId('announcement-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('Pool opens Saturday')).toBeOnTheScreen();

    // Back to the feed and into the center again.
    await user.press(screen.getByRole('button', { name: /^Home/ }));
    await openCenter(user);
    await user.press(await row('Alert: Boil water'));
    expect(await screen.findByTestId('alert-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('Boil water')).toBeOnTheScreen();
  });

  test('an event opens its event', async () => {
    const { user } = await start();
    await openCenter(user);
    await user.press(await row('New event: Spring concert'));
    expect(await screen.findByTestId('event-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('Spring concert')).toBeOnTheScreen();
  });

  test('a document opens its document, and its file through a short-lived link', async () => {
    const { user } = await start();
    await openCenter(user);
    await user.press(await row('New document: Bylaws'));
    expect(await screen.findByTestId('document-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('Bylaws.pdf')).toBeOnTheScreen();
    expect(screen.getByTestId('document-facts')).toHaveTextContent(/PDF · 117 KB · Added/);
    const { Linking } = jest.requireActual<typeof import('react-native')>('react-native');
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await user.press(screen.getByRole('button', { name: 'Open document' }));
    await waitFor(() => expect(openURL).toHaveBeenCalledWith(expect.stringMatching(/expires=60$/)));
  });

  test('an accepted membership opens the community', async () => {
    const { user } = await start();
    await openCenter(user);
    await user.press(await row('Welcome to St. Mark Choir'));
    expect(await screen.findByTestId('community-home-screen')).toBeOnTheScreen();
    expect(screen.getAllByText('St. Mark Choir').length).toBeGreaterThan(0);
  });

  test('one with nothing to open shows in full; read / unread can be toggled', async () => {
    const { user, notifications } = await start();
    await openCenter(user);
    await user.press(await row('Welcome to CommuniOne'));
    expect(await screen.findByTestId('notification-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('Glad you are here.')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByTestId('notification-state')).toHaveTextContent(/^Read$/));
    const welcome = notifications.find((n) => n.title === 'Welcome to CommuniOne')!;
    expect(welcome.read_at).not.toBeNull();

    await user.press(screen.getByRole('button', { name: 'Mark as unread' }));
    await waitFor(() => expect(screen.getByTestId('notification-state')).toHaveTextContent(/^Unread$/));
    expect(welcome.read_at).toBeNull();
    await user.press(screen.getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(welcome.read_at).not.toBeNull());
  });
});

describe('unauthorized targets', () => {
  test('a hidden post: the notification opens, the post does not', async () => {
    const { user } = await start({
      content: { ...content(), [C]: { ...content()[C], posts: [{ ...post, status: 'hidden' }] } },
    });
    await openCenter(user);
    await user.press(await row('Grace commented on your post'));
    expect(await screen.findByText('This post is not available')).toBeOnTheScreen();
    expect(screen.queryByText('Choir trip')).not.toBeOnTheScreen();
  });

  test('a community the user has left: nothing opens and the community is not switched', async () => {
    const { user, setCommunities, rpc } = await start();
    await openCenter(user);
    // Removed from the choir after the inbox loaded (its notifications are
    // still on screen; the server now refuses the community).
    setCommunities([maple]);
    await user.press(await row('New event: Spring concert'));
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent(
      /You can't open this any more/,
    );
    expect(screen.queryByTestId('event-detail-screen')).not.toBeOnTheScreen();
    expect(screen.getByTestId('notifications-screen')).toBeOnTheScreen();
    // No event was read for the choir.
    expect(rpcNames(rpc)).not.toContain('get_event');
  });

  test('membership rule: a suspended member no longer sees that community’s notifications', async () => {
    const { user, rpc } = await start({
      communities: [maple, { ...choir, membership_status: 'suspended' }],
    });
    const list = await openCenter(user);
    const labels = within(list)
      .getAllByRole('button')
      .map((b) => b.props.accessibilityLabel as string)
      .join('\n');
    // Community content types require membership (notification_types.requires_membership).
    expect(labels).not.toMatch(/Grace commented|Spring concert/);
    expect(labels).toMatch(/Pool opens Saturday/);
    // Membership and system types stay the user's own; their targets are still checked.
    expect(labels).toMatch(/Welcome to St\. Mark Choir/);
    await user.press(await row('New document: Bylaws'));
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent(
      /You can't open this any more/,
    );
    expect(screen.queryByTestId('document-detail-screen')).not.toBeOnTheScreen();
    expect(rpcNames(rpc)).not.toContain('get_document');
  });

  test('a document the user may not see is refused by its screen', async () => {
    const { user } = await start({
      content: {
        ...content(),
        [C]: { ...content()[C], documents: [{ ...document, visibility: 'managers' }] },
      },
    });
    await openCenter(user);
    await user.press(await row('New document: Bylaws'));
    expect(await screen.findByText('This document is not available')).toBeOnTheScreen();
    expect(screen.queryByText('Bylaws.pdf')).not.toBeOnTheScreen();
  });

  test('an item from another community is refused even if the data claims this one', async () => {
    // Forged data: the notification says Maple, the post is the choir's.
    const forged = makeNotification(1, {
      community_id: M,
      type: 'comment',
      title: 'Forged',
      data: { post_id: post.id },
    });
    const { user } = await start({ notifications: [forged] });
    await openCenter(user);
    await user.press(await row('Forged'));
    expect(await screen.findByText('This post is not available')).toBeOnTheScreen();
  });

  test('malformed ids lead nowhere: the notification just shows in full', async () => {
    const odd = makeNotification(1, {
      community_id: M,
      type: 'announcement',
      title: 'Odd',
      data: { announcement_id: "x' OR 1=1 --" },
    });
    const { user, queries } = await start({ notifications: [odd] });
    await openCenter(user);
    await user.press(await row('Odd'));
    expect(await screen.findByTestId('notification-detail-screen')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Open the announcement' })).not.toBeOnTheScreen();
    expect(JSON.stringify(queries)).not.toMatch(/OR 1=1/);
  });
});

describe('deep links', () => {
  test('communione://notifications opens the center', async () => {
    await start({ initialURL: 'communione://notifications' });
    expect(await screen.findByTestId('notifications-screen')).toBeOnTheScreen();
    expect(await screen.findByText('Grace commented on your post')).toBeOnTheScreen();
  });

  test('communione://notifications/<id> opens it and marks it read', async () => {
    const target = makeNotification(4);
    const { notifications } = await start({ initialURL: `communione://notifications/${target.id}` });
    expect(await screen.findByTestId('notification-detail-screen')).toBeOnTheScreen();
    expect(screen.getByText('New event: Spring concert')).toBeOnTheScreen();
    await waitFor(() => expect(notifications[3]!.read_at).not.toBeNull());
    // Its destination still goes through the server.
    const user = userEvent.setup();
    await user.press(screen.getByRole('button', { name: 'Open the event' }));
    expect(await screen.findByTestId('event-detail-screen')).toBeOnTheScreen();
  });

  test('a link to someone else’s notification shows nothing of it', async () => {
    const theirs = makeNotification(9, { user_id: OTHER_USER_ID, title: 'Private to Grace' });
    const { notifications } = await start({
      initialURL: `communione://notifications/${theirs.id}`,
      notifications: [...inbox(), theirs],
    });
    expect(await screen.findByText('This notification is not available')).toBeOnTheScreen();
    expect(screen.queryByText('Private to Grace')).not.toBeOnTheScreen();
    expect(notifications.at(-1)!.read_at).toBeNull();
  });

  test('a link to a malformed id shows "not available"', async () => {
    await start({ initialURL: 'communione://notifications/not-a-uuid' });
    expect(await screen.findByText(/notification (is not available|could not be loaded)/)).toBeOnTheScreen();
  });

  test('from a link, the destination is still refused once the user has left its community', async () => {
    const target = makeNotification(4);
    const { setCommunities } = await start({ initialURL: `communione://notifications/${target.id}` });
    await screen.findByTestId('notification-detail-screen');
    setCommunities([maple]); // removed from the choir on the server
    const user = userEvent.setup();
    await user.press(screen.getByRole('button', { name: 'Open the event' }));
    expect(await screen.findByTestId('notification-error')).toHaveTextContent(/You can't open this any more/);
    expect(screen.queryByTestId('event-detail-screen')).not.toBeOnTheScreen();
  });
});

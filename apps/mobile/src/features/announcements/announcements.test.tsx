// Announcements through the whole app (REAL service layer) against a fake
// Supabase applying the database rules: visibility (drafts only to managers
// and their author), current vs past lists, expiry, the lifecycle trigger,
// and announcements.create / announcements.manage.
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeAnnouncement,
  makeSession,
  OTHER_USER_ID,
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
const M = maple.community_id; // the user is the Owner: announcements.manage
const C = choir.community_id; // the user is a Member: view only

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
/** Ids are unique per community (offset), as they are in the database. */
const announcementsFor = (communityId: string, o = communityId === M ? 0 : 50) => [
  makeAnnouncement(communityId, o + 1, {
    title: 'Pool opens',
    body: 'Saturday at 10.',
    published_at: hours(-1),
  }),
  makeAnnouncement(communityId, o + 2, {
    title: 'Water off',
    body: 'Tuesday 9 to 12.',
    priority: 'important',
    published_at: hours(-5),
  }),
  makeAnnouncement(communityId, o + 3, {
    title: 'Old notice',
    body: 'Gone',
    published_at: hours(-50),
    expires_at: hours(-2),
  }),
  makeAnnouncement(communityId, o + 4, {
    title: 'Summer fair',
    body: 'Archived',
    status: 'archived',
    published_at: hours(-90),
    archived_at: hours(-80),
  }),
  makeAnnouncement(communityId, o + 5, {
    title: 'Their draft',
    body: 'WIP',
    status: 'draft',
    published_at: null,
    author_user_id: OTHER_USER_ID,
  }),
  makeAnnouncement(communityId, o + 6, {
    title: 'My draft',
    body: 'Mine',
    status: 'draft',
    published_at: null,
    author_user_id: TEST_USER_ID,
  }),
  makeAnnouncement(communityId, o + 7, {
    title: 'Bake sale',
    body: 'Friday',
    published_at: hours(-3),
    expires_at: hours(48),
  }),
];

async function openAnnouncements(community: 'member' | 'manager', options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [community === 'manager' ? maple : choir],
    content: { [M]: { announcements: announcementsFor(M) }, [C]: { announcements: announcementsFor(C) } },
    ...options,
  });
  await openHub();
  await user.press(screen.getByRole('button', { name: 'See all announcements' }));
  const list = await screen.findByTestId('announcements-screen');
  await within(list).findAllByTestId(/^announcement-[0-9a-f-]+$/);
  return { user, ...app };
}

/** Titles in the announcements list (the home screen stays mounted below it). */
const listTitles = () =>
  within(screen.getByTestId('announcements-screen'))
    .queryAllByTestId(/^announcement-[0-9a-f-]+$/)
    .map((node) => (node.props.accessibilityLabel as string).split('. ')[1]);
const inList = () => within(screen.getByTestId('announcements-screen'));

async function openTab(user: User, name: string) {
  await user.press(screen.getByRole('tab', { name }));
}

async function openDetail(user: User, title: string) {
  await user.press(inList().getByRole('button', { name: new RegExp(`(^|\\. )${title}(\\.|$)`) }));
  return screen.findByTestId('announcement-detail-screen');
}

describe('published announcements', () => {
  test('members see current announcements, important first, with priority and date', async () => {
    await openAnnouncements('member');
    expect(listTitles()).toEqual(['Water off', 'Pool opens', 'Bake sale']);
    expect(inList().getByRole('button', { name: /^Important announcement\. Water off/ })).toBeOnTheScreen();
    expect(inList().getAllByText(/^Published /).length).toBeGreaterThan(0);
  });

  test('the detail shows title, priority, dates and body, without controls for members', async () => {
    const { user } = await openAnnouncements('member');
    const detail = await openDetail(user, 'Water off');
    expect(within(detail).getByText('Important announcement')).toBeOnTheScreen();
    expect(within(detail).getByText('Water off')).toBeOnTheScreen();
    expect(within(detail).getByTestId('announcement-dates')).toHaveTextContent(/^Published /);
    expect(within(detail).getByText('Tuesday 9 to 12.')).toBeOnTheScreen();
    expect(screen.queryByTestId('announcement-controls')).not.toBeOnTheScreen();
  });

  test('the community home links to them', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      content: { [C]: { announcements: announcementsFor(C) } },
    });
    await openHub();
    await user.press(
      within(screen.getByTestId('home-announcements')).getByRole('button', { name: /Water off/ }),
    );
    expect(await screen.findByTestId('announcement-detail-screen')).toBeOnTheScreen();
  });
});

describe('expiration', () => {
  test('expired announcements leave Current and stay under Past, marked', async () => {
    const { user } = await openAnnouncements('member');
    expect(listTitles()).not.toContain('Old notice');
    expect(
      within(screen.getByTestId(/announcement-b2b2b2b2-0000-4000-8000-000000000057/)).getByText(/Expires /),
    ).toBeOnTheScreen();

    await openTab(user, 'Past');
    await waitFor(() => expect(listTitles()).toContain('Old notice'));
    const expired = inList().getByRole('button', { name: /Old notice\. Expired/ });
    expect(within(expired).getByText('Expired')).toBeOnTheScreen();
    expect(listTitles()).toContain('Summer fair');
    expect(inList().getByRole('button', { name: /Summer fair\. Archived/ })).toBeOnTheScreen();

    const detail = await openDetail(user, 'Old notice');
    expect(within(detail).getByTestId('announcement-dates')).toHaveTextContent(/Expired /);
  });
});

describe('drafts', () => {
  test('members have no Drafts view and never receive drafts', async () => {
    const { user } = await openAnnouncements('member');
    expect(screen.queryByRole('tab', { name: 'Drafts' })).not.toBeOnTheScreen();
    await openTab(user, 'Past');
    await waitFor(() => expect(listTitles()).toContain('Old notice'));
    expect(listTitles()).not.toContain('My draft');
    expect(listTitles()).not.toContain('Their draft');
  });

  test('managers see every draft', async () => {
    const { user } = await openAnnouncements('manager');
    await openTab(user, 'Drafts');
    await waitFor(() => expect(listTitles().sort()).toEqual(['My draft', 'Their draft']));
  });

  test('authors with announcements.create see only their own drafts', async () => {
    const { user } = await openAnnouncements('member', {
      permissions: { [C]: ['announcements.view', 'announcements.create'] },
    });
    await openTab(user, 'Drafts');
    await waitFor(() => expect(listTitles()).toEqual(['My draft']));
  });
});

describe('admin controls', () => {
  test('create a draft, publish it, edit, archive, publish again, delete', async () => {
    const { user, content } = await openAnnouncements('manager');
    await user.press(screen.getByRole('button', { name: 'New announcement' }));
    await screen.findByTestId('announcement-editor-screen');
    await user.type(screen.getByLabelText('Title'), 'Road closure');
    await user.type(screen.getByLabelText('Announcement'), 'Elm Street closed Monday.');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));

    await openTab(user, 'Drafts');
    const detail = await openDetail(user, 'Road closure');
    expect(within(detail).getByTestId('announcement-status')).toHaveTextContent('Draft');
    await user.press(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByText('Publish this announcement? All members will be notified.')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Publish now' }));
    expect(await screen.findByTestId('announcement-done')).toHaveTextContent(/Published/);
    expect(screen.getByTestId('announcement-dates')).toHaveTextContent(/^Published /);
    const row = () => content[M]!.announcements!.find((a) => a.title === 'Road closure')!;
    expect(row()).toMatchObject({ status: 'published', author_user_id: TEST_USER_ID, community_id: M });

    // Edit (published edits are marked).
    await user.press(screen.getByRole('button', { name: 'Edit' }));
    const body = await screen.findByLabelText('Announcement');
    await user.clear(body);
    await user.type(body, 'Elm Street closed Monday and Tuesday.');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Elm Street closed Monday and Tuesday.')).toBeOnTheScreen();
    expect(screen.getByTestId('announcement-dates')).toHaveTextContent(/Edited/);

    await user.press(screen.getByRole('button', { name: 'Archive' }));
    await user.press(screen.getAllByRole('button', { name: 'Archive' }).at(-1)!);
    expect(await screen.findByTestId('announcement-status')).toHaveTextContent('Archived');
    expect(row().status).toBe('archived');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Publish again' }));
    await user.press(screen.getAllByRole('button', { name: 'Publish again' }).at(-1)!);
    await waitFor(() => expect(row().status).toBe('published'));

    await user.press(screen.getByRole('button', { name: 'Delete announcement' }));
    await user.press(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByTestId('announcements-screen');
    expect(row().status).toBe('deleted');
  });

  test('publish at once, as important: it leads the current list', async () => {
    const { user } = await openAnnouncements('manager');
    await user.press(screen.getByRole('button', { name: 'New announcement' }));
    await user.type(await screen.findByLabelText('Title'), 'Storm tonight');
    await user.type(screen.getByLabelText('Announcement'), 'Secure loose items.');
    await user.press(screen.getByRole('radio', { name: 'Important' }));
    await user.press(screen.getByRole('button', { name: 'Publish now' }));
    await screen.findByTestId('announcements-screen');
    await waitFor(() => expect(listTitles()[0]).toBe('Storm tonight'));
  });

  test('validation: title, body and expiry date are checked before sending', async () => {
    const { user, queries } = await openAnnouncements('manager');
    await user.press(screen.getByRole('button', { name: 'New announcement' }));
    await screen.findByTestId('announcement-editor-screen');
    await user.type(screen.getByLabelText('Expires on (optional)'), '12/31/2026');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Enter a title.')).toBeOnTheScreen();
    expect(screen.getByText('Write the announcement.')).toBeOnTheScreen();
    expect(screen.getByText('Use the format YYYY-MM-DD, e.g. 2026-12-31.')).toBeOnTheScreen();
    await user.clear(screen.getByLabelText('Expires on (optional)'));
    await user.type(screen.getByLabelText('Expires on (optional)'), '2001-01-01');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Choose a date in the future.')).toBeOnTheScreen();
    expect(queries.some((q) => q.table === 'announcements' && q.op === 'insert')).toBe(false);
  });

  test('the server refuses to publish a draft whose expiry has passed', async () => {
    const { user, content } = await openAnnouncements('manager');
    content[M]!.announcements!.find((a) => a.title === 'My draft')!.expires_at = hours(-1);
    await openTab(user, 'Drafts');
    await openDetail(user, 'My draft');
    await user.press(screen.getByRole('button', { name: 'Publish' }));
    await user.press(screen.getByRole('button', { name: 'Publish now' }));
    expect(await screen.findByTestId('announcement-error')).toHaveTextContent(/expiry date has passed/);
    expect(content[M]!.announcements!.find((a) => a.title === 'My draft')!.status).toBe('draft');
  });
});

describe('permissions', () => {
  test('members see no New button and no controls', async () => {
    const { user } = await openAnnouncements('member');
    expect(screen.queryByRole('button', { name: 'New announcement' })).not.toBeOnTheScreen();
    await openDetail(user, 'Pool opens');
    expect(screen.queryByTestId('announcement-controls')).not.toBeOnTheScreen();
  });

  test("authors see no controls on other people's announcements", async () => {
    const { user } = await openAnnouncements('member', {
      permissions: { [C]: ['announcements.view', 'announcements.create'] },
    });
    expect(screen.getByRole('button', { name: 'New announcement' })).toBeOnTheScreen();
    await openDetail(user, 'Pool opens');
    expect(screen.queryByTestId('announcement-controls')).not.toBeOnTheScreen();
  });

  test('authors manage their own drafts', async () => {
    const { user } = await openAnnouncements('member', {
      permissions: { [C]: ['announcements.view', 'announcements.create'] },
    });
    await openTab(user, 'Drafts');
    await openDetail(user, 'My draft');
    const controls = screen.getByTestId('announcement-controls');
    for (const name of ['Edit', 'Publish', 'Delete announcement']) {
      expect(within(controls).getByRole('button', { name })).toBeOnTheScreen();
    }
  });

  test('a manager whose permission was removed meanwhile is refused by the server', async () => {
    const permissions = { [M]: ['announcements.view', 'announcements.create', 'announcements.manage'] };
    const { user, content } = await openAnnouncements('manager', { permissions });
    await openDetail(user, 'Pool opens');
    permissions[M] = ['announcements.view'];
    await user.press(screen.getByRole('button', { name: 'Archive' }));
    await user.press(screen.getAllByRole('button', { name: 'Archive' }).at(-1)!);
    expect(await screen.findByTestId('announcement-error')).toHaveTextContent(/permission/);
    expect(content[M]!.announcements!.find((a) => a.title === 'Pool opens')!.status).toBe('published');
  });
});

describe('community isolation', () => {
  test("requests are for the current community; another community's rows are never shown", async () => {
    const mixed = [
      ...announcementsFor(C),
      makeAnnouncement(M, 9, { title: 'Maple only', published_at: hours(-1) }),
    ];
    const { rpc } = await openAnnouncements('member', { content: { [C]: { announcements: mixed } } });
    expect(listTitles()).not.toContain('Maple only');
    const calls = rpc.mock.calls
      .filter(([n]) => String(n).includes('announcement'))
      .map(([, a]) => (a as { p_community_id: string }).p_community_id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((id) => id === C)).toBe(true);
  });

  test("switching community shows the other community's announcements", async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: {
        [M]: { announcements: [makeAnnouncement(M, 1, { title: 'Maple meeting', published_at: hours(-1) })] },
        [C]: { announcements: [makeAnnouncement(C, 2, { title: 'Choir concert', published_at: hours(-1) })] },
      },
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    await openHub();
    await user.press(await screen.findByRole('button', { name: 'See all announcements' }));
    await screen.findByText('Choir concert');
    await user.press(screen.getByRole('button', { name: /^Communities/ }));
    await user.press(await screen.findByTestId('community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    await openHub();
    await user.press(await screen.findByRole('button', { name: 'See all announcements' }));
    expect(await screen.findByText('Maple meeting')).toBeOnTheScreen();
    expect(screen.queryByText('Choir concert')).not.toBeOnTheScreen();
  });
});

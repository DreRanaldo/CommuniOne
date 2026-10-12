// Events and RSVPs through the whole app (REAL service layer) against a fake
// Supabase applying the database rules: visibility (drafts only to managers
// and their organizer), upcoming vs past, the lifecycle trigger, RSVP with
// capacity and the FIFO waitlist, and events.create / events.manage.
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeEvent,
  makeRsvp,
  makeSession,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;
type Content = Record<string, { events?: Record<string, unknown>[]; rsvps?: Record<string, unknown>[] }>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // the user is the Owner: events.create + events.manage
const C = choir.community_id; // the user is a Member: events.view only
const ORGANIZER = { [C]: ['events.view', 'events.create'] }; // a custom "Organizer" role
const THIRD_USER = 'cccccccc-0000-4000-8000-000000000003';

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const timed = (startHours: number, lengthHours = 2) => ({
  starts_at: hours(startHours),
  ends_at: hours(startHours + lengthHours),
});
const eventId = (o: number, n: number) => makeEvent('x', o + n).id;

/** Ids are unique per community (offset), as they are in the database. */
function contentFor(communityId: string, o = communityId === M ? 0 : 50) {
  const events = [
    makeEvent(communityId, o + 1, {
      title: 'Book club',
      description: 'We read "Middlemarch".',
      location_text: 'Library',
      timezone: 'Europe/London',
      capacity: 2,
      created_by: OTHER_USER_ID,
      ...timed(24),
    }),
    makeEvent(communityId, o + 2, { title: 'Choir night', location_text: 'Church hall', ...timed(72) }),
    makeEvent(communityId, o + 3, {
      title: 'Garden party',
      status: 'cancelled',
      cancellation_reason: 'Rain forecast',
      ...timed(48),
    }),
    makeEvent(communityId, o + 4, { title: 'Summer fair', ...timed(-240) }),
    makeEvent(communityId, o + 5, { title: 'AGM', status: 'completed', ...timed(-72) }),
    makeEvent(communityId, o + 6, {
      title: 'Their draft',
      status: 'draft',
      created_by: OTHER_USER_ID,
      ...timed(120),
    }),
    makeEvent(communityId, o + 7, {
      title: 'My draft',
      status: 'draft',
      created_by: TEST_USER_ID,
      ...timed(144),
    }),
    makeEvent(communityId, o + 8, {
      title: 'Full concert',
      capacity: 1,
      created_by: OTHER_USER_ID,
      ...timed(96),
    }),
    makeEvent(communityId, o + 9, { title: 'Live now', created_by: TEST_USER_ID, ...timed(-1, 3) }),
  ];
  const rsvps = [
    makeRsvp(eventId(o, 1), OTHER_USER_ID, 'going'),
    makeRsvp(eventId(o, 8), OTHER_USER_ID, 'going'),
    makeRsvp(eventId(o, 8), THIRD_USER, 'waitlisted', hours(-5)),
  ];
  return { events, rsvps };
}

async function openEvents(community: 'member' | 'manager', options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [community === 'manager' ? maple : choir],
    content: { [M]: contentFor(M), [C]: contentFor(C) },
    ...options,
  });
  await screen.findByTestId('community-home-screen');
  await user.press(screen.getByRole('button', { name: 'See all upcoming events' }));
  await screen.findByTestId('events-screen');
  await settle();
  return { user, ...app, content: app.content as Content };
}

const inList = () => within(screen.getByTestId('events-screen'));
const settle = () => waitFor(() => expect(inList().queryByText('Loading events…')).not.toBeOnTheScreen());
/** Titles in the events list (the home screen stays mounted below it). */
const listTitles = () =>
  inList()
    .queryAllByTestId(/^event-[0-9a-f-]+$/)
    .map((node) => (node.props.accessibilityLabel as string).split('. ')[0]!.replace('Event: ', ''));
const item = (title: string) =>
  inList()
    .getAllByTestId(/^event-[0-9a-f-]+$/)
    .find((node) => (node.props.accessibilityLabel as string).startsWith(`Event: ${title}.`))!;

async function openTab(user: User, name: string) {
  await user.press(screen.getByRole('tab', { name }));
  await settle();
}

async function openDetail(user: User, title: string) {
  await user.press(item(title));
  const detail = await screen.findByTestId('event-detail-screen');
  return detail;
}

/** Back to the home (tab press pops the stack) and into the list again: a fresh read. */
async function reopenList(user: User) {
  await user.press(screen.getByRole('button', { name: /^Home/ }));
  await user.press(await screen.findByRole('button', { name: 'See all upcoming events' }));
  await screen.findByTestId('events-screen');
  await settle();
}

const row = (content: Content, cid: string, title: string) =>
  content[cid]!.events!.find((e) => e.title === title)!;
const myRsvp = (content: Content, cid: string, title: string) =>
  content[cid]!.rsvps!.find((r) => r.event_id === row(content, cid, title).id && r.user_id === TEST_USER_ID);
const detailText = (testID: string) => screen.getByTestId(testID);

describe('event lists', () => {
  test('upcoming: soonest first, with date, time zone and place; cancelled ones stay, marked', async () => {
    await openEvents('member');
    expect(listTitles()).toEqual(['Live now', 'Book club', 'Garden party', 'Choir night', 'Full concert']);
    expect(item('Book club').props.accessibilityLabel).toMatch(
      /^Event: Book club\. .+, \d\d:\d\d – \d\d:\d\d \(Europe\/London\)\. Library\. Limited to 2 places$/,
    );
    expect(within(item('Garden party')).getByText('Cancelled')).toBeOnTheScreen();
    expect(within(item('Live now')).getByText('Happening now')).toBeOnTheScreen();
  });

  test('past: newest first, marked completed or ended; drafts are never listed for members', async () => {
    const { user } = await openEvents('member');
    expect(screen.queryByRole('tab', { name: 'Drafts' })).not.toBeOnTheScreen();
    await openTab(user, 'Past');
    expect(listTitles()).toEqual(['AGM', 'Summer fair']);
    expect(within(item('AGM')).getByText('Completed')).toBeOnTheScreen();
    expect(within(item('Summer fair')).getByText('Ended')).toBeOnTheScreen();
  });

  test('the community home shows upcoming events and opens their detail', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [choir], content: { [C]: contentFor(C) } });
    const home = await screen.findByTestId('home-events');
    await user.press(within(home).getByRole('button', { name: /^Event: Book club\./ }));
    expect(await screen.findByTestId('event-detail-screen')).toBeOnTheScreen();
  });
});

describe('event details', () => {
  test('title, description, date, time, time zone, location, places, organizer and my reply', async () => {
    const { user } = await openEvents('member');
    const detail = await openDetail(user, 'Book club');
    expect(within(detail).getByText('Book club')).toBeOnTheScreen();
    expect(within(detail).getByText('We read "Middlemarch".')).toBeOnTheScreen();
    expect(detailText('event-date')).toHaveTextContent(/\d{4}/);
    expect(detailText('event-time')).toHaveTextContent(/^\d\d:\d\d – \d\d:\d\d$/);
    expect(detailText('event-timezone')).toHaveTextContent(/^Europe\/London/);
    expect(detailText('event-location')).toHaveTextContent('Library');
    expect(detailText('event-capacity')).toHaveTextContent('1 of 2 places taken · 1 left');
    expect(detailText('event-organizer')).toHaveTextContent('Grace H.');
    expect(detailText('event-my-rsvp')).toHaveTextContent("You haven't replied yet.");
    expect(screen.queryByTestId('event-controls')).not.toBeOnTheScreen();
  });

  test('a cancelled event shows why, and replies are closed', async () => {
    const { user } = await openEvents('member');
    await openDetail(user, 'Garden party');
    expect(detailText('event-status')).toHaveTextContent('Cancelled');
    expect(detailText('event-cancellation-reason')).toHaveTextContent(/Rain forecast/);
    expect(detailText('event-rsvp-closed')).toHaveTextContent(/cancelled/);
    expect(screen.queryByRole('radio', { name: 'Going' })).not.toBeOnTheScreen();
  });

  test('an event that has started takes no more replies', async () => {
    const { user } = await openEvents('member');
    await openDetail(user, 'Live now');
    expect(detailText('event-rsvp-closed')).toHaveTextContent(/has started/);
  });
});

describe('RSVP', () => {
  test('going, then changing to maybe, then removing the reply; places follow the server', async () => {
    const { user, content } = await openEvents('member');
    await openDetail(user, 'Book club');
    await user.press(screen.getByRole('radio', { name: 'Going' }));
    expect(await screen.findByTestId('event-done')).toHaveTextContent(/Your\ reply\ is\ saved:\ Going\./);
    expect(detailText('event-my-rsvp')).toHaveTextContent("You're going.");
    expect(detailText('event-capacity')).toHaveTextContent('Full · 2 of 2 places taken');
    expect(screen.getByRole('radio', { name: 'Going' })).toBeChecked();
    expect(myRsvp(content, C, 'Book club')).toMatchObject({ status: 'going', user_id: TEST_USER_ID });

    await user.press(screen.getByRole('radio', { name: 'Maybe' }));
    await waitFor(() => expect(detailText('event-my-rsvp')).toHaveTextContent('You might go.'));
    expect(detailText('event-capacity')).toHaveTextContent('1 of 2 places taken · 1 left');
    expect(screen.getByRole('radio', { name: 'Maybe' })).toBeChecked();

    await user.press(screen.getByRole('button', { name: 'Remove my reply' }));
    await waitFor(() => expect(detailText('event-my-rsvp')).toHaveTextContent("You haven't replied yet."));
    expect(myRsvp(content, C, 'Book club')).toBeUndefined();
  });

  test('a full event: Going puts you on the waitlist, with your place in the queue', async () => {
    const { user, content } = await openEvents('member');
    await openDetail(user, 'Full concert');
    expect(detailText('event-capacity')).toHaveTextContent('Full · 1 of 1 places taken · 1 on the waitlist');
    expect(screen.getByText('The event is full. Choosing Going puts you on the waitlist.')).toBeOnTheScreen();
    await user.press(screen.getByRole('radio', { name: 'Going' }));
    expect(await screen.findByTestId('event-done')).toHaveTextContent(
      /The event is full\. You're on the waitlist\./,
    );
    expect(detailText('event-my-rsvp')).toHaveTextContent(/^You're on the waitlist \(number 2\)/);
    expect(detailText('event-capacity')).toHaveTextContent(/2 on the waitlist/);
    expect(myRsvp(content, C, 'Full concert')!.status).toBe('waitlisted');

    // Leaving the waitlist: Not going.
    await user.press(screen.getByRole('radio', { name: 'Not going' }));
    await waitFor(() => expect(detailText('event-my-rsvp')).toHaveTextContent("You're not going."));
    expect(detailText('event-capacity')).toHaveTextContent(/· 1 on the waitlist/);
  });

  test("promotion from the waitlist is the server's: after it, the reply reads Going", async () => {
    const { user, content } = await openEvents('member');
    // We wait behind THIRD_USER; OTHER_USER is going.
    content[C]!.rsvps!.push(
      makeRsvp(row(content, C, 'Full concert').id as string, TEST_USER_ID, 'waitlisted', hours(-1)),
    );
    await openDetail(user, 'Full concert');
    expect(detailText('event-my-rsvp')).toHaveTextContent(/number 2/);
    // The organizer raises capacity to 3 (as the database would, both waiting people are promoted).
    const concert = row(content, C, 'Full concert');
    concert.capacity = 3;
    for (const r of content[C]!.rsvps!)
      if (r.event_id === concert.id && r.status === 'waitlisted')
        Object.assign(r, { status: 'going', waitlisted_at: null });
    await reopenList(user);
    await openDetail(user, 'Full concert');
    expect(detailText('event-my-rsvp')).toHaveTextContent("You're going.");
    expect(detailText('event-capacity')).toHaveTextContent('Full · 3 of 3 places taken');
  });

  test('one request at a time: while a reply is being saved, the choices are locked', async () => {
    const { user, rpc } = await openEvents('member');
    await openDetail(user, 'Choir night');
    // Hold the server's answer until we release it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'rsvp_to_event') await gate;
      return real(name, args);
    });
    await user.press(screen.getByRole('radio', { name: 'Going' }));
    expect(screen.getByRole('radio', { name: 'Maybe' })).toBeDisabled();
    await user.press(screen.getByRole('radio', { name: 'Maybe' }));
    await user.press(screen.getByRole('radio', { name: 'Not going' }));
    expect(rpc.mock.calls.filter(([n]) => n === 'rsvp_to_event')).toHaveLength(1);
    await act(async () => release());
    expect(await screen.findByTestId('event-done')).toHaveTextContent(/Going/);
    await waitFor(() => expect(detailText('event-my-rsvp')).toHaveTextContent("You're going."));
    expect(rpc.mock.calls.filter(([n]) => n === 'rsvp_to_event')).toHaveLength(1);
  });

  test('replies refused by the server (cancelled meanwhile) are explained, and the event re-read', async () => {
    const { user, content } = await openEvents('member');
    await openDetail(user, 'Choir night');
    row(content, C, 'Choir night').status = 'cancelled';
    await user.press(screen.getByRole('radio', { name: 'Going' }));
    expect(await screen.findByTestId('event-error')).toHaveTextContent(/Replies are closed for this event/);
    expect(await screen.findByTestId('event-rsvp-closed')).toHaveTextContent(/cancelled/);
    expect(myRsvp(content, C, 'Choir night')).toBeUndefined();
  });
});

describe('managing events', () => {
  test('create and publish: times are in the chosen time zone; it appears in Upcoming', async () => {
    const { user, content } = await openEvents('manager');
    await user.press(screen.getByRole('button', { name: 'New event' }));
    await screen.findByTestId('event-editor-screen');
    const day = new Date(Date.now() + 8 * 86400_000).toISOString().slice(0, 10);
    await user.type(screen.getByLabelText('Title'), 'Quiz night');
    await user.type(screen.getByLabelText('Date'), day);
    await user.type(screen.getByLabelText('Starts at'), '19:30');
    await user.type(screen.getByLabelText('Ends at'), '22:00');
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'Asia/Tokyo');
    await user.type(screen.getByLabelText('Location (optional)'), 'Pub');
    await user.type(screen.getByLabelText('Places (optional)'), '30');
    await user.press(screen.getByRole('button', { name: 'Publish now' }));
    await screen.findByTestId('events-screen');
    await waitFor(() => expect(listTitles()).toContain('Quiz night'));
    const created = row(content, M, 'Quiz night');
    // 19:30 in Tokyo (UTC+9, no daylight saving) is 10:30 UTC.
    expect(created).toMatchObject({
      status: 'published',
      timezone: 'Asia/Tokyo',
      capacity: 30,
      location_text: 'Pub',
      created_by: TEST_USER_ID,
      community_id: M,
      starts_at: `${day}T10:30:00.000Z`,
      ends_at: `${day}T13:00:00.000Z`,
    });
  });

  test('validation: date, times, time zone and places are checked before sending', async () => {
    const { user, queries } = await openEvents('manager');
    await user.press(screen.getByRole('button', { name: 'New event' }));
    await screen.findByTestId('event-editor-screen');
    await user.type(screen.getByLabelText('Date'), '31/12/2026');
    await user.type(screen.getByLabelText('Starts at'), '7pm');
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'Mars/Base');
    await user.type(screen.getByLabelText('Places (optional)'), '0');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Enter a title.')).toBeOnTheScreen();
    expect(screen.getByText('Use the format YYYY-MM-DD, e.g. 2026-12-31.')).toBeOnTheScreen();
    expect(screen.getByText('Use the format HH:MM, e.g. 18:30.')).toBeOnTheScreen();
    expect(screen.getByText('Use the format HH:MM, e.g. 20:00.')).toBeOnTheScreen();
    expect(screen.getByText('Use a time zone such as Europe/London or America/Chicago.')).toBeOnTheScreen();
    expect(screen.getByText(/Enter a whole number from 1 to 100,000/)).toBeOnTheScreen();
    expect(queries.some((q) => q.table === 'events' && q.op === 'insert')).toBe(false);
  });

  test('draft → publish → edit → cancel with a reason', async () => {
    const { user, content } = await openEvents('manager');
    await openTab(user, 'Drafts');
    expect(listTitles().sort()).toEqual(['My draft', 'Their draft']);
    await openDetail(user, 'My draft');
    expect(detailText('event-status')).toHaveTextContent('Draft');
    expect(detailText('event-rsvp-closed')).toHaveTextContent(/published/);
    await user.press(screen.getByRole('button', { name: 'Publish' }));
    await user.press(screen.getByRole('button', { name: 'Publish now' }));
    expect(await screen.findByTestId('event-done')).toHaveTextContent(/Published/);
    expect(row(content, M, 'My draft').status).toBe('published');
    expect(await screen.findByRole('radio', { name: 'Going' })).toBeOnTheScreen();

    const startsBefore = row(content, M, 'My draft').starts_at;
    await user.press(screen.getByRole('button', { name: 'Edit' }));
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Open meeting');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Open meeting')).toBeOnTheScreen();
    const edited = row(content, M, 'Open meeting');
    expect(edited.edited_at).toBeTruthy();
    expect(edited.starts_at).toBe(startsBefore); // times untouched: not resent

    await user.press(screen.getByRole('button', { name: 'Cancel event' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Room unavailable');
    await user.press(screen.getAllByRole('button', { name: 'Cancel event' }).at(-1)!);
    expect(await screen.findByTestId('event-done')).toHaveTextContent(/Cancelled/);
    expect(detailText('event-cancellation-reason')).toHaveTextContent(/Room unavailable/);
    expect(row(content, M, 'Open meeting')).toMatchObject({
      status: 'cancelled',
      cancellation_reason: 'Room unavailable',
    });
    expect(screen.queryByTestId('event-controls')).not.toBeOnTheScreen();
  });

  test('complete: only once the event has started', async () => {
    const { user, content } = await openEvents('manager');
    await openDetail(user, 'Choir night');
    expect(
      within(screen.getByTestId('event-controls')).queryByRole('button', { name: 'Mark completed' }),
    ).not.toBeOnTheScreen();
    await reopenList(user);
    await openDetail(user, 'Live now');
    await user.press(screen.getByRole('button', { name: 'Mark completed' }));
    await user.press(screen.getAllByRole('button', { name: 'Mark completed' }).at(-1)!);
    expect(await screen.findByTestId('event-done')).toHaveTextContent(/Completed\./);
    expect(detailText('event-status')).toHaveTextContent('Completed');
    expect(row(content, M, 'Live now').status).toBe('completed');
  });

  test('places cannot drop below the number going: the server refuses, explained', async () => {
    const { user, content } = await openEvents('manager');
    content[M]!.rsvps!.push(makeRsvp(row(content, M, 'Book club').id as string, THIRD_USER, 'going'));
    await openDetail(user, 'Book club');
    await user.press(screen.getByRole('button', { name: 'Edit' }));
    const places = await screen.findByLabelText('Places (optional)');
    await user.clear(places);
    await user.type(places, '1');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('event-editor-error')).toHaveTextContent(
      /More people are already going/,
    );
    expect(row(content, M, 'Book club').capacity).toBe(2);
  });
});

describe('permissions', () => {
  test('members: no New button, no Drafts, no controls; the backend refuses creation', async () => {
    const { user, dependencies, content } = await openEvents('member');
    expect(screen.queryByRole('button', { name: 'New event' })).not.toBeOnTheScreen();
    await openDetail(user, 'Choir night');
    expect(screen.queryByTestId('event-controls')).not.toBeOnTheScreen();
    await expect(
      dependencies.services.events.create({
        communityId: C,
        title: 'Sneaky',
        startsAt: hours(10),
        endsAt: hours(11),
        publish: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      dependencies.services.events.cancel(row(content, C, 'Choir night').id as string),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(content[C]!.events!.some((e) => e.title === 'Sneaky')).toBe(false);
    expect(row(content, C, 'Choir night').status).toBe('published');
  });

  test('organizers: New and their own drafts; no control of other people’s events', async () => {
    const { user } = await openEvents('member', { permissions: ORGANIZER });
    expect(screen.getByRole('button', { name: 'New event' })).toBeOnTheScreen();
    await openTab(user, 'Drafts');
    expect(listTitles()).toEqual(['My draft']);
    await openDetail(user, 'My draft');
    for (const name of ['Edit', 'Publish', 'Discard draft']) {
      expect(within(screen.getByTestId('event-controls')).getByRole('button', { name })).toBeOnTheScreen();
    }
    await reopenList(user);
    await openDetail(user, 'Book club');
    expect(screen.queryByTestId('event-controls')).not.toBeOnTheScreen();
  });

  test('a manager whose permission was removed meanwhile is refused by the server', async () => {
    const permissions = { [M]: ['events.view', 'events.create', 'events.manage'] };
    const { user, content } = await openEvents('manager', { permissions });
    await openDetail(user, 'Book club');
    permissions[M] = ['events.view'];
    await user.press(screen.getByRole('button', { name: 'Cancel event' }));
    await user.press(screen.getAllByRole('button', { name: 'Cancel event' }).at(-1)!);
    expect(await screen.findByTestId('event-error')).toHaveTextContent(/permission|no longer available/);
    expect(row(content, M, 'Book club').status).toBe('published');
  });
});

describe('community isolation', () => {
  test("requests are for the current community; another community's rows are never shown", async () => {
    const mixed = contentFor(C);
    mixed.events.push(makeEvent(M, 30, { title: 'Maple only', ...timed(30) }));
    const { user, rpc } = await openEvents('member', { content: { [C]: mixed } });
    expect(listTitles()).not.toContain('Maple only');
    await openTab(user, 'Past');
    expect(listTitles()).not.toContain('Maple only');
    const calls = rpc.mock.calls
      .filter(([n]) => String(n).includes('events'))
      .map(([, a]) => (a as { p_community_id: string }).p_community_id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((id) => id === C)).toBe(true);
  });

  test("another community's event cannot be opened or answered", async () => {
    const { dependencies } = await openEvents('member');
    const mapleEvent = makeEvent(M, 1).id;
    await expect(dependencies.services.events.get(mapleEvent)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(dependencies.services.events.rsvp(mapleEvent, 'going')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test("switching community shows the other community's events", async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: {
        [M]: { events: [makeEvent(M, 1, { title: 'Maple picnic', ...timed(24) })] },
        [C]: { events: [makeEvent(C, 2, { title: 'Choir rehearsal', ...timed(24) })] },
      },
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    await user.press(await screen.findByRole('button', { name: 'See all upcoming events' }));
    await screen.findByText('Choir rehearsal');
    await user.press(screen.getByRole('button', { name: /^Home/ }));
    await user.press(await screen.findByTestId('community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    await user.press(await screen.findByRole('button', { name: 'See all upcoming events' }));
    expect(await screen.findByText('Maple picnic')).toBeOnTheScreen();
    expect(screen.queryByText('Choir rehearsal')).not.toBeOnTheScreen();
  });
});

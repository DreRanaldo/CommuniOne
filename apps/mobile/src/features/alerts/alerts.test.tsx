// Alerts through the whole app (REAL service layer) against a fake Supabase
// applying the database rules: visibility (drafts only to managers and their
// creator), active vs history, expiry, the lifecycle trigger (issue, end,
// cancel, archive), the emergency rules, and alerts.create / alerts.manage.
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';
import {
  makeAlert,
  makeEvent,
  makeSession,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';
import { lightTheme } from '@/theme';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // the user is the Owner: alerts.create + alerts.manage
const C = choir.community_id; // the user is a Member: alerts.view only
const CREATOR = { [C]: ['alerts.view', 'alerts.create'] }; // a "Warden" in the choir

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const sev = (severity: string) => ({
  severity,
  severity_rank: { info: 1, warning: 2, urgent: 3, emergency: 4 }[severity],
  is_emergency: severity === 'emergency',
});
/** Ids are unique per community (offset), as they are in the database. */
const alertsFor = (communityId: string, o = communityId === M ? 0 : 50) => [
  makeAlert(communityId, o + 1, {
    title: 'Gas leak',
    body: 'Leave Oak Street now.',
    ...sev('emergency'),
    published_at: hours(-2),
  }),
  makeAlert(communityId, o + 2, {
    title: 'Bin day moved',
    body: 'Thursday.',
    ...sev('info'),
    published_at: hours(-1),
  }),
  makeAlert(communityId, o + 3, {
    title: 'Boil water',
    body: 'Until further notice.',
    ...sev('urgent'),
    published_at: hours(-5),
    expires_at: hours(24),
  }),
  makeAlert(communityId, o + 4, {
    title: 'Ice on paths',
    body: 'Take care.',
    ...sev('warning'),
    published_at: hours(-30),
    expires_at: hours(-1),
  }),
  makeAlert(communityId, o + 5, {
    title: 'Power cut',
    body: 'North side.',
    ...sev('warning'),
    status: 'cancelled',
    published_at: hours(-6),
    cancelled_at: hours(-3),
    cancellation_reason: 'Power restored',
  }),
  makeAlert(communityId, o + 6, {
    title: 'Their draft',
    body: 'WIP',
    ...sev('info'),
    status: 'draft',
    published_at: null,
    created_by: OTHER_USER_ID,
  }),
  makeAlert(communityId, o + 7, {
    title: 'My draft',
    body: 'Mine',
    ...sev('warning'),
    status: 'draft',
    published_at: null,
    created_by: TEST_USER_ID,
  }),
  makeAlert(communityId, o + 8, {
    title: 'Old flood',
    body: 'River.',
    ...sev('urgent'),
    status: 'expired',
    published_at: hours(-50),
    expired_at: hours(-40),
  }),
  makeAlert(communityId, o + 9, {
    title: 'Last year storm',
    body: 'Stay in.',
    ...sev('emergency'),
    status: 'archived',
    published_at: hours(-500),
    expired_at: hours(-490),
    archived_at: hours(-400),
  }),
];

async function openAlerts(community: 'member' | 'manager', options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [community === 'manager' ? maple : choir],
    content: { [M]: { alerts: alertsFor(M) }, [C]: { alerts: alertsFor(C) } },
    ...options,
  });
  await openHub();
  await user.press(screen.getByRole('button', { name: 'See all alerts' }));
  const list = await screen.findByTestId('alerts-screen');
  await waitFor(() => expect(within(list).queryByText('Loading alerts…')).not.toBeOnTheScreen());
  return { user, ...app };
}

const inList = () => within(screen.getByTestId('alerts-screen'));
/** Titles in the alerts list (the home screen stays mounted below it). */
const listTitles = () =>
  inList()
    .queryAllByTestId(/^alert-[0-9a-f-]+$/)
    .map((node) => (node.props.accessibilityLabel as string).split(': ')[1]!.split('. ')[0]);
const card = (title: string) =>
  inList()
    .getAllByTestId(/^alert-[0-9a-f-]+$/)
    .find((node) => (node.props.accessibilityLabel as string).includes(`: ${title}.`))!;
const styleOf = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as ViewStyle) as ViewStyle & { color?: string; fontSize?: number };

/** Back to the home (tab press pops the stack) and into the list again: a fresh read. */
async function reopenList(user: User) {
  await user.press(screen.getByRole('button', { name: /^Communities/ }));
  await user.press(await screen.findByRole('button', { name: 'See all alerts' }));
  const list = await screen.findByTestId('alerts-screen');
  await waitFor(() => expect(within(list).queryByText('Loading alerts…')).not.toBeOnTheScreen());
}

async function openTab(user: User, name: string) {
  await user.press(screen.getByRole('tab', { name }));
  await waitFor(() => expect(inList().queryByText('Loading alerts…')).not.toBeOnTheScreen());
}

async function openDetail(user: User, title: string) {
  await user.press(card(title));
  return screen.findByTestId('alert-detail-screen');
}

const row = (content: Record<string, { alerts?: Record<string, unknown>[] }>, cid: string, title: string) =>
  content[cid]!.alerts!.find((a) => a.title === title)!;

describe('severity', () => {
  test('every level has its own icon and spoken label, not only a colour', async () => {
    await openAlerts('member');
    for (const [title, label, level] of [
      ['Gas leak', 'EMERGENCY', 'emergency'],
      ['Boil water', 'URGENT', 'urgent'],
      ['Bin day moved', 'INFORMATION', 'info'],
    ] as const) {
      const node = card(title);
      expect(within(node).getByTestId(`severity-${level}`)).toHaveTextContent(new RegExp(label));
      expect(node.props.accessibilityLabel).toMatch(
        new RegExp(`^${label[0]}${label.slice(1).toLowerCase()} alert: ${title}`),
      );
    }
  });

  test('history shows warnings too, each marked with its level and status', async () => {
    const { user } = await openAlerts('member');
    await openTab(user, 'History');
    expect(within(card('Ice on paths')).getByTestId('severity-warning')).toHaveTextContent(/WARNING/);
    expect(card('Ice on paths').props.accessibilityLabel).toMatch(/^Warning alert: Ice on paths\. Ended/);
  });
});

describe('active alerts', () => {
  test('emergencies first, then by severity; ended, cancelled, archived and drafts are not active', async () => {
    await openAlerts('member');
    expect(listTitles()).toEqual(['Gas leak', 'Boil water', 'Bin day moved']);
    expect(within(card('Boil water')).getByText(/Ends /)).toBeOnTheScreen();
  });

  test('an all-clear state when nothing is active', async () => {
    // Only an ended alert (and an event, so the home is not empty): nothing is active.
    const ended = alertsFor(C).filter((a) => a.title === 'Ice on paths');
    await openAlerts('member', { content: { [C]: { alerts: ended, events: [makeEvent(C, 1)] } } });
    expect(inList().getByText('No active alerts.')).toBeOnTheScreen();
    expect(inList().getByText('All clear right now.')).toBeOnTheScreen();
  });

  test('the community home shows them and opens the detail; "See all" opens the list', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      content: { [C]: { alerts: alertsFor(C) } },
    });
    await openHub();
    const home = await screen.findByTestId('home-alerts');
    await user.press(within(home).getByLabelText(/^Emergency alert: Gas leak/));
    const detail = await screen.findByTestId('alert-detail-screen');
    expect(within(detail).getByText('Leave Oak Street now.')).toBeOnTheScreen();
  });
});

describe('emergency presentation', () => {
  test('an active emergency is a solid block with inverse text, a larger title, announced at once', async () => {
    await openAlerts('member');
    const emergency = card('Gas leak');
    expect(styleOf(emergency).backgroundColor).toBe(lightTheme.colors.severity.emergency);
    expect(emergency.props.accessibilityLiveRegion).toBe('assertive');
    const title = within(emergency).getByText('Gas leak');
    expect(styleOf(title).color).toBe(lightTheme.colors.textInverse);
    expect(styleOf(title).fontSize).toBe(lightTheme.typography.title.fontSize);
    // Other levels keep the normal surface and title size.
    const urgent = card('Boil water');
    expect(styleOf(urgent).backgroundColor).toBe(lightTheme.colors.surface);
    expect(urgent.props.accessibilityLiveRegion).toBeUndefined();
    expect(styleOf(within(urgent).getByText('Boil water')).fontSize).toBe(
      lightTheme.typography.heading.fontSize,
    );
  });

  test('the detail repeats it: emergency header, what it means, read out as an alert', async () => {
    const { user } = await openAlerts('member');
    const detail = await openDetail(user, 'Gas leak');
    const header = within(detail).getByTestId('alert-severity-header');
    expect(header.props.accessibilityRole).toBe('alert');
    expect(header.props.accessibilityLabel).toMatch(/^Emergency alert: Gas leak\. Active\. Immediate danger/);
    expect(styleOf(header).backgroundColor).toBe(lightTheme.colors.severity.emergency);
  });

  test('a past emergency stays labelled EMERGENCY but is no longer shown as in force', async () => {
    const { user } = await openAlerts('member');
    await openTab(user, 'History');
    const past = card('Last year storm');
    expect(within(past).getByTestId('severity-emergency')).toHaveTextContent(/EMERGENCY/);
    expect(within(past).getByText('Archived')).toBeOnTheScreen();
    expect(styleOf(past).backgroundColor).toBe(lightTheme.colors.surface);
    expect(past.props.accessibilityLiveRegion).toBeUndefined();
  });
});

describe('expiration and history', () => {
  test('an alert past its end time leaves Active and is marked Ended in History', async () => {
    const { user } = await openAlerts('member');
    expect(listTitles()).not.toContain('Ice on paths');
    await openTab(user, 'History');
    expect(listTitles()).toEqual([
      'Bin day moved',
      'Gas leak',
      'Boil water',
      'Power cut',
      'Ice on paths',
      'Old flood',
      'Last year storm',
    ]);
    expect(within(card('Ice on paths')).getByText('Ended')).toBeOnTheScreen();
    expect(within(card('Old flood')).getByText('Ended')).toBeOnTheScreen();
    expect(within(card('Power cut')).getByText('Cancelled')).toBeOnTheScreen();
    const detail = await openDetail(user, 'Ice on paths');
    expect(within(detail).getByTestId('alert-status')).toHaveTextContent('Ended');
    expect(within(detail).getByTestId('alert-dates')).toHaveTextContent(/Ended /);
  });

  test('a cancelled alert shows when and why it was cancelled', async () => {
    const { user } = await openAlerts('member');
    await openTab(user, 'History');
    const detail = await openDetail(user, 'Power cut');
    expect(within(detail).getByTestId('alert-dates')).toHaveTextContent(/Cancelled /);
    expect(within(detail).getByTestId('alert-cancellation-reason')).toHaveTextContent(/Power restored/);
  });
});

describe('managing alerts', () => {
  test('issue an emergency at once: it leads the active list', async () => {
    const { user, content } = await openAlerts('manager');
    await user.press(screen.getByRole('button', { name: 'New alert' }));
    await screen.findByTestId('alert-editor-screen');
    for (const level of ['emergency', 'urgent', 'warning', 'info']) {
      expect(screen.getByTestId(`severity-choice-${level}`)).toBeOnTheScreen();
    }
    await user.type(screen.getByLabelText('Title'), 'Wildfire');
    await user.type(screen.getByLabelText('What is happening and what to do'), 'Evacuate to the school.');
    await user.press(screen.getByRole('radio', { name: /^Emergency\./ }));
    await user.press(screen.getByRole('button', { name: 'Issue emergency alert' }));
    await screen.findByTestId('alerts-screen');
    await waitFor(() => expect(listTitles()[0]).toBe('Wildfire'));
    expect(row(content, M, 'Wildfire')).toMatchObject({
      status: 'published',
      severity: 'emergency',
      created_by: TEST_USER_ID,
      community_id: M,
    });
  });

  test('draft → issue → edit → end now → archive', async () => {
    const { user, content } = await openAlerts('manager');
    await user.press(screen.getByRole('button', { name: 'New alert' }));
    await user.type(await screen.findByLabelText('Title'), 'Road closed');
    await user.type(screen.getByLabelText('What is happening and what to do'), 'Use Pine Road.');
    await user.press(screen.getByRole('radio', { name: /^Warning\./ }));
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    await openTab(user, 'Drafts');
    const detail = await openDetail(user, 'Road closed');
    expect(within(detail).getByTestId('alert-status')).toHaveTextContent('Draft');

    await user.press(screen.getByRole('button', { name: 'Issue' }));
    expect(screen.getByText(/^Issue this warning alert now\?/)).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Issue now' }));
    expect(await screen.findByTestId('alert-done')).toHaveTextContent(/Issued/);
    expect(row(content, M, 'Road closed')).toMatchObject({ status: 'published', severity: 'warning' });

    await user.press(screen.getByRole('button', { name: 'Edit' }));
    const body = await screen.findByLabelText('What is happening and what to do');
    await user.clear(body);
    await user.type(body, 'Use Pine Road or Ash Lane.');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Use Pine Road or Ash Lane.')).toBeOnTheScreen();
    expect(screen.getByTestId('alert-dates')).toHaveTextContent(/Updated/);

    await user.press(screen.getByRole('button', { name: 'End now' }));
    await user.press(screen.getAllByRole('button', { name: 'End now' }).at(-1)!);
    expect(await screen.findByTestId('alert-done')).toHaveTextContent(/Ended/);
    expect(screen.getByTestId('alert-status')).toHaveTextContent('Ended');
    expect(row(content, M, 'Road closed').status).toBe('expired');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Archive' }));
    await user.press(screen.getAllByRole('button', { name: 'Archive' }).at(-1)!);
    expect(await screen.findByTestId('alert-status')).toHaveTextContent('Archived');
    expect(row(content, M, 'Road closed').status).toBe('archived');
    expect(screen.queryByTestId('alert-controls')).not.toBeOnTheScreen();
  });

  test('cancel with a reason: it leaves Active and members see why', async () => {
    const { user, content } = await openAlerts('manager');
    await openDetail(user, 'Bin day moved');
    await user.press(screen.getByRole('button', { name: 'Cancel alert' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Sent by mistake');
    await user.press(screen.getAllByRole('button', { name: 'Cancel alert' }).at(-1)!);
    expect(await screen.findByTestId('alert-done')).toHaveTextContent(/Cancelled/);
    expect(screen.getByTestId('alert-cancellation-reason')).toHaveTextContent(/Sent by mistake/);
    expect(row(content, M, 'Bin day moved')).toMatchObject({
      status: 'cancelled',
      cancellation_reason: 'Sent by mistake',
    });
    await reopenList(user);
    expect(listTitles()).not.toContain('Bin day moved');
  });

  test('validation: title, body, end date and time are checked before sending', async () => {
    const { user, queries } = await openAlerts('manager');
    await user.press(screen.getByRole('button', { name: 'New alert' }));
    await screen.findByTestId('alert-editor-screen');
    await user.type(screen.getByLabelText('Ends on (optional)'), '31/12/2026');
    await user.type(screen.getByLabelText('At (optional)'), '7pm');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Enter a title.')).toBeOnTheScreen();
    expect(screen.getByText('Say what is happening and what to do.')).toBeOnTheScreen();
    expect(screen.getByText('Use the format YYYY-MM-DD, e.g. 2026-12-31.')).toBeOnTheScreen();
    await user.clear(screen.getByLabelText('Ends on (optional)'));
    await user.type(screen.getByLabelText('Ends on (optional)'), '2001-01-01');
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Use the format HH:MM, e.g. 18:30.')).toBeOnTheScreen();
    await user.clear(screen.getByLabelText('At (optional)'));
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    expect(screen.getByText('Choose a time in the future.')).toBeOnTheScreen();
    expect(queries.some((q) => q.table === 'alerts' && q.op === 'insert')).toBe(false);
  });

  test('the server refuses to issue a draft whose end time has passed', async () => {
    const { user, content } = await openAlerts('manager');
    row(content, M, 'My draft').expires_at = hours(-1);
    await openTab(user, 'Drafts');
    await openDetail(user, 'My draft');
    await user.press(screen.getByRole('button', { name: 'Issue' }));
    await user.press(screen.getByRole('button', { name: 'Issue now' }));
    expect(await screen.findByTestId('alert-error')).toHaveTextContent(/end time has passed/);
    expect(row(content, M, 'My draft').status).toBe('draft');
  });
});

describe('permissions', () => {
  test('members: no New button, no Drafts, no drafts received, no controls', async () => {
    const { user, rpc } = await openAlerts('member');
    expect(screen.queryByRole('button', { name: 'New alert' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Drafts' })).not.toBeOnTheScreen();
    await openTab(user, 'History');
    expect(listTitles()).not.toContain('My draft');
    expect(listTitles()).not.toContain('Their draft');
    await openDetail(user, 'Boil water');
    expect(screen.queryByTestId('alert-controls')).not.toBeOnTheScreen();
    // Even a request for drafts would come back empty (RLS).
    const { data } = await rpc('list_alert_history', { p_community_id: C, p_statuses: ['draft'] });
    expect(data).toEqual([]);
  });

  test('creators: New and their own drafts, but no emergency and no control of others’ alerts', async () => {
    const { user } = await openAlerts('member', { permissions: CREATOR });
    await openTab(user, 'Drafts');
    expect(listTitles()).toEqual(['My draft']);
    await openDetail(user, 'My draft');
    const controls = screen.getByTestId('alert-controls');
    for (const name of ['Edit', 'Issue', 'Discard draft']) {
      expect(within(controls).getByRole('button', { name })).toBeOnTheScreen();
    }
    await user.press(within(controls).getByRole('button', { name: 'Edit' }));
    await screen.findByTestId('alert-editor-screen');
    expect(screen.queryByTestId('severity-choice-emergency')).not.toBeOnTheScreen();
    expect(
      screen.getByText(/Emergency alerts can be issued only by people who manage alerts/),
    ).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Cancel' }));

    await reopenList(user);
    await openDetail(user, 'Gas leak');
    expect(screen.queryByTestId('alert-controls')).not.toBeOnTheScreen();
  });

  test('the backend refuses an emergency from a creator, whatever the app sends', async () => {
    const { dependencies, content } = await openAlerts('member', { permissions: CREATOR });
    const { alerts } = dependencies.services;
    // The screens never offer it; the database (RLS + trigger) is the authority.
    await expect(
      alerts.create({ communityId: C, title: 'Fake', body: 'x', severity: 'emergency', publish: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const draft = row(content, C, 'My draft').id as string;
    await expect(alerts.edit(draft, { severity: 'emergency' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(content[C]!.alerts!.some((a) => a.title === 'Fake')).toBe(false);
    expect(row(content, C, 'My draft').severity).toBe('warning');
  });

  test('a draft raised to emergency by a manager cannot be issued by its creator', async () => {
    const { user, content } = await openAlerts('member', { permissions: CREATOR });
    Object.assign(row(content, C, 'My draft'), sev('emergency'));
    await openTab(user, 'Drafts');
    await openDetail(user, 'My draft');
    const controls = screen.getByTestId('alert-controls');
    expect(within(controls).queryByRole('button', { name: 'Issue' })).not.toBeOnTheScreen();
    expect(
      within(controls).getByText(/Only people who manage alerts can issue an emergency alert/),
    ).toBeOnTheScreen();
  });

  test('a manager whose permission was removed meanwhile is refused by the server', async () => {
    const permissions = { [M]: ['alerts.view', 'alerts.create', 'alerts.manage'] };
    const { user, content } = await openAlerts('manager', { permissions });
    await openDetail(user, 'Boil water');
    permissions[M] = ['alerts.view'];
    await user.press(screen.getByRole('button', { name: 'End now' }));
    await user.press(screen.getAllByRole('button', { name: 'End now' }).at(-1)!);
    expect(await screen.findByTestId('alert-error')).toHaveTextContent(/permission|no longer available/);
    expect(row(content, M, 'Boil water').status).toBe('published');
  });
});

describe('community isolation', () => {
  test("requests are for the current community; another community's rows are never shown", async () => {
    const mixed = [
      ...alertsFor(C),
      makeAlert(M, 20, { title: 'Maple only', ...sev('emergency'), published_at: hours(-1) }),
    ];
    const { user, rpc } = await openAlerts('member', { content: { [C]: { alerts: mixed } } });
    expect(listTitles()).not.toContain('Maple only');
    await openTab(user, 'History');
    expect(listTitles()).not.toContain('Maple only');
    const calls = rpc.mock.calls
      .filter(([n]) => String(n).includes('alert'))
      .map(([, a]) => (a as { p_community_id: string }).p_community_id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((id) => id === C)).toBe(true);
  });

  test("switching community shows the other community's alerts", async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: {
        [M]: {
          alerts: [makeAlert(M, 1, { title: 'Maple flood', ...sev('urgent'), published_at: hours(-1) })],
        },
        [C]: {
          alerts: [makeAlert(C, 2, { title: 'Choir fire drill', ...sev('info'), published_at: hours(-1) })],
        },
      },
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    await openHub();
    await user.press(await screen.findByRole('button', { name: 'See all alerts' }));
    await screen.findByText('Choir fire drill');
    await user.press(screen.getByRole('button', { name: /^Communities/ }));
    await user.press(await screen.findByTestId('community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    await openHub();
    await user.press(await screen.findByRole('button', { name: 'See all alerts' }));
    expect(await screen.findByText('Maple flood')).toBeOnTheScreen();
    expect(screen.queryByText('Choir fire drill')).not.toBeOnTheScreen();
  });
});

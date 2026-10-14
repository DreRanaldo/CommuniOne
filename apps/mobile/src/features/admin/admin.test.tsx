// Mobile admin tools (RN-16) through the whole app (REAL service layer)
// against a fake Supabase applying the database rules: membership RLS and
// private.enforce_membership_update (approve / suspend / remove and the
// "cover" rule), membership_roles anti-escalation, the invitation functions,
// alert removal (migration 30) and moderation. Every control is shown from
// permission keys; every refusal comes from the backend.
import { Share } from 'react-native';
import { fireEvent, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeAlert,
  makeAnnouncement,
  makeEvent,
  makeMember,
  makePost,
  makeSession,
  sampleCommunities,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';
import { adminTools, memberActions } from './adminRules';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // Owner here
const C = choir.community_id; // Member here

const people = () => ({
  [M]: [
    makeMember(1, { display_name: 'Sarah Member' }),
    makeMember(2, { display_name: 'Paul Pending', status: 'pending', role_names: [] }),
    makeMember(3, { display_name: 'Sam Suspended', status: 'suspended' }),
    makeMember(4, { display_name: 'Alex Admin', role_names: ['Admin'] }),
    makeMember(5, { display_name: 'Olive Owner', role_names: ['Owner'] }),
  ],
  [C]: [makeMember(6, { display_name: 'Chris Choir' })],
});

/** Signed in as `role` in Maple Grove, on the admin tools. */
async function openAdmin(role = 'Owner', options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [{ ...maple, role_names: [role] }],
    members: people(),
    ...options,
  });
  await openHub();
  await user.press(await screen.findByRole('button', { name: 'Admin tools' }));
  await screen.findByTestId('admin-screen');
  return { user, ...app };
}

async function openMember(user: ReturnType<typeof userEvent.setup>, name: RegExp, tab?: string) {
  await user.press(screen.getByRole('button', { name: 'Members and requests' }));
  await screen.findByTestId('admin-members-screen');
  if (tab) await user.press(screen.getByRole('tab', { name: tab }));
  await user.press(await screen.findByRole('button', { name }));
  await screen.findByTestId('admin-member-actions');
}

describe('admin actions (Owner)', () => {
  test('all tools, grouped and separate from member actions', async () => {
    await openAdmin();
    for (const group of ['people', 'content', 'moderation', 'community'])
      expect(screen.getByTestId(`admin-group-${group}`)).toBeOnTheScreen();
    for (const tool of [
      'Members and requests',
      'Invite members',
      'New announcement',
      'New alert',
      'Manage events',
      'Manage documents',
      'Hidden and deleted posts',
      'Community profile',
    ])
      expect(screen.getByRole('button', { name: tool })).toBeOnTheScreen();
  });

  test('approve a request: the member becomes active with the default role', async () => {
    const { user, memberRows } = await openAdmin();
    await openMember(user, /^Paul Pending/, 'Requests');
    await user.press(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByTestId('admin-member-done')).toHaveTextContent(/Approved/);
    const paul = memberRows[M]!.find((m) => m.display_name === 'Paul Pending')!;
    expect(paul.status).toBe('active');
    expect(paul.role_names).toEqual(['Member']);
  });

  test('decline a request after confirming', async () => {
    const { user, memberRows } = await openAdmin();
    await openMember(user, /^Paul Pending/, 'Requests');
    await user.press(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByText(/Decline Paul Pending's request/)).toBeOnTheScreen();
    await user.press(screen.getAllByRole('button', { name: 'Decline' }).at(-1)!);
    await waitFor(() =>
      expect(memberRows[M]!.find((m) => m.display_name === 'Paul Pending')!.status).toBe('rejected'),
    );
  });

  test('suspend after confirming, then reinstate', async () => {
    const { user, memberRows } = await openAdmin();
    await openMember(user, /^Sarah Member/);
    await user.press(screen.getByRole('button', { name: 'Suspend' }));
    expect(screen.getByText(/They lose access to Maple Grove HOA at once/)).toBeOnTheScreen();
    await user.press(screen.getAllByRole('button', { name: 'Suspend' }).at(-1)!);
    expect(await screen.findByTestId('admin-member-done')).toHaveTextContent(/Suspended/);
    const sarah = memberRows[M]!.find((m) => m.display_name === 'Sarah Member')!;
    expect(sarah.status).toBe('suspended');
    expect(sarah.role_names).toEqual(['Member']); // suspension keeps roles
    await user.press(screen.getByRole('button', { name: 'Reinstate' }));
    await waitFor(() => expect(sarah.status).toBe('active'));
  });

  test('"Keep" cancels a suspension without any request', async () => {
    const { user, queries } = await openAdmin();
    await openMember(user, /^Sarah Member/);
    await user.press(screen.getByRole('button', { name: 'Suspend' }));
    await user.press(screen.getByRole('button', { name: 'Keep' }));
    expect(queries.filter((q) => q.table === 'memberships' && q.op === 'update')).toEqual([]);
  });

  test('remove a suspended member: gone from the list', async () => {
    const { user, memberRows } = await openAdmin();
    await openMember(user, /^Sam Suspended/, 'Suspended');
    await user.press(screen.getByRole('button', { name: 'Remove from community' }));
    await user.press(screen.getAllByRole('button', { name: 'Remove from community' }).at(-1)!);
    await screen.findByTestId('admin-members-screen');
    await waitFor(() => expect(memberRows[M]!.some((m) => m.display_name === 'Sam Suspended')).toBe(false));
    expect(screen.queryByRole('button', { name: /^Sam Suspended/ })).not.toBeOnTheScreen();
  });

  test('roles: the Owner gives and takes the Moderator role', async () => {
    const { user, memberRows } = await openAdmin();
    await openMember(user, /^Sarah Member/);
    const toggle = await screen.findByLabelText('Moderator role');
    expect(toggle.props.value).toBe(false);
    fireEvent(toggle, 'valueChange', true);
    await waitFor(() =>
      expect(memberRows[M]!.find((m) => m.display_name === 'Sarah Member')!.role_names).toContain(
        'Moderator',
      ),
    );
    expect(await screen.findByTestId('admin-member-done')).toHaveTextContent(/now has the Moderator role/);
    fireEvent(screen.getByLabelText('Moderator role'), 'valueChange', false);
    await waitFor(() =>
      expect(memberRows[M]!.find((m) => m.display_name === 'Sarah Member')!.role_names).toEqual(['Member']),
    );
  });

  test('nobody manages their own membership or roles, not even the Owner', async () => {
    const { user } = await openAdmin();
    await user.press(screen.getByRole('button', { name: 'Members and requests' }));
    await user.press(await screen.findByRole('button', { name: /^Ada L\.\. You/ }));
    expect(await screen.findByText(/Nobody can change their own membership/)).toBeOnTheScreen();
    expect(screen.queryByTestId('admin-member-actions')).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('Owner role')).not.toBeOnTheScreen();
  });
});

describe('invitations', () => {
  test('create: the code and link are shown once, shared, then listed without the code', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const { user, createdInvitations, rpc } = await openAdmin();
    await user.press(screen.getByRole('button', { name: 'Invite members' }));
    await screen.findByTestId('invitation-form');
    expect(await screen.findByTestId('no-invitations')).toBeOnTheScreen();
    await user.press(screen.getByRole('radio', { name: '30 days' }));
    await user.press(screen.getByRole('radio', { name: 'Up to 10' }));
    await user.press(screen.getByRole('button', { name: 'Create invitation' }));
    const code = await screen.findByTestId('invitation-code');
    const token = createdInvitations[0]!.token;
    expect(code).toHaveTextContent(token);
    expect(screen.getByTestId('invitation-link')).toHaveTextContent(`communione://join?token=${token}`);
    expect(rpc).toHaveBeenCalledWith('create_invitation', {
      p_community_id: M,
      p_expires_in: '30 days',
      p_max_uses: 10,
    });
    await user.press(screen.getByRole('button', { name: 'Share invitation' }));
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining(token) });
    await user.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('invitation-code')).not.toBeOnTheScreen();
    expect(await screen.findByText(/Used 0 of 10/)).toBeOnTheScreen();
    expect(screen.queryByText(new RegExp(token))).not.toBeOnTheScreen();
  });

  test('revoke after confirming: the invitation stops working', async () => {
    const { user, createdInvitations, invitations } = await openAdmin();
    await user.press(screen.getByRole('button', { name: 'Invite members' }));
    await user.press(await screen.findByRole('button', { name: 'Create invitation' }));
    await user.press(await screen.findByRole('button', { name: 'Done' }));
    await user.press(await screen.findByRole('button', { name: 'Revoke invitation' }));
    await user.press(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByTestId('invitations-done')).toHaveTextContent(/revoked/);
    expect(createdInvitations[0]!.status).toBe('revoked');
    expect(invitations.get(createdInvitations[0]!.token)?.state).toBe('revoked');
    expect(await screen.findByTestId('no-invitations')).toBeOnTheScreen();
  });
});

describe('moderator actions', () => {
  test('a Moderator gets members and moderation only', async () => {
    await openAdmin('Moderator');
    expect(screen.getByRole('button', { name: 'Members and requests' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Hidden and deleted posts' })).toBeOnTheScreen();
    for (const tool of ['Invite members', 'New announcement', 'New alert', 'Community profile'])
      expect(screen.queryByRole('button', { name: tool })).not.toBeOnTheScreen();
  });

  test('suspends a member, but cannot approve or remove', async () => {
    const { user, memberRows } = await openAdmin('Moderator');
    await user.press(screen.getByRole('button', { name: 'Members and requests' }));
    await screen.findByTestId('admin-members-screen');
    expect(screen.queryByRole('tab', { name: 'Requests' })).not.toBeOnTheScreen();
    await user.press(await screen.findByRole('button', { name: /^Sarah Member/ }));
    await screen.findByTestId('admin-member-actions');
    expect(screen.queryByRole('button', { name: 'Remove from community' })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('Moderator role')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Suspend' }));
    await user.press(screen.getAllByRole('button', { name: 'Suspend' }).at(-1)!);
    await waitFor(() =>
      expect(memberRows[M]!.find((m) => m.display_name === 'Sarah Member')!.status).toBe('suspended'),
    );
  });

  test('cannot suspend an Admin (the cover rule) and is told why', async () => {
    const { user, memberRows } = await openAdmin('Moderator');
    await openMember(user, /^Alex Admin/);
    await user.press(screen.getByRole('button', { name: 'Suspend' }));
    await user.press(screen.getAllByRole('button', { name: 'Suspend' }).at(-1)!);
    expect(await screen.findByTestId('admin-member-error')).toHaveTextContent(
      /they hold permissions you don't have/,
    );
    expect(memberRows[M]!.find((m) => m.display_name === 'Alex Admin')!.status).toBe('active');
  });

  test('the backend refuses removals and approvals, whatever the app shows', async () => {
    const app = await renderApp({
      session: makeSession(),
      communities: [{ ...maple, role_names: ['Moderator'] }],
      members: people(),
    });
    await screen.findByTestId('feed-screen');
    const { memberships } = app.dependencies.services;
    const [sarah, paul] = app.memberRows[M]!;
    await expect(memberships.remove(sarah!.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // members.suspend shows pending rows, but approving needs members.approve.
    await expect(memberships.approve(paul!.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(app.memberRows[M]!).toHaveLength(5);
    expect(paul!.status).toBe('pending');
  });
});

describe('member restrictions', () => {
  test('no admin entry points anywhere; hub and settings stay clean', async () => {
    const user = userEvent.setup();
    await renderApp({ session: makeSession(), communities: [choir], members: people() });
    await openHub();
    expect(screen.queryByTestId('hub-admin')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Community settings' }));
    await screen.findByTestId('notification-settings');
    expect(screen.queryByTestId('settings-admin')).not.toBeOnTheScreen();
  });

  test('the backend refuses every admin action and hides non-active members', async () => {
    const app = await renderApp({ session: makeSession(), communities: [choir], members: people() });
    await screen.findByTestId('feed-screen');
    const { memberships, invitations, roles } = app.dependencies.services;
    const chris = app.memberRows[C]![0]!;
    await expect(memberships.suspend(chris.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberships.remove(chris.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invitations.create({ communityId: C })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await invitations.list({ communityId: C })).toEqual([]);
    const moderator = (await roles.list(C)).find((r) => r.name === 'Moderator')!;
    await expect(roles.assign(chris.membership_id, moderator.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await memberships.list({ communityId: C, status: 'suspended' })).items).toEqual([]);
    expect(chris.status).toBe('active');
    expect(chris.role_names).toEqual(['Member']);
  });

  test("members cannot end, cancel or archive anyone's alert", async () => {
    const alert = makeAlert(C, 1, { created_by: 'someone-else' });
    const app = await renderApp({
      session: makeSession(),
      communities: [choir],
      content: { [C]: { alerts: [alert] } },
    });
    await screen.findByTestId('feed-screen');
    const { alerts } = app.dependencies.services;
    await expect(alerts.cancel(alert.id)).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/),
    });
    await expect(alerts.expire(alert.id)).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/),
    });
    expect(app.content[C]!.alerts![0]).toMatchObject({ status: 'published' });
  });

  test('an author who may issue alerts (no alerts.manage) cannot take her published alert down', async () => {
    const user = userEvent.setup();
    const permissions = { [C]: ['community.view', 'alerts.view', 'alerts.create', 'posts.view'] };
    const mine = makeAlert(C, 2, { created_by: makeSession().user.id, title: 'Pool closed' });
    const app = await renderApp({
      session: makeSession(),
      communities: [choir],
      permissions,
      content: { [C]: { alerts: [mine] } },
    });
    await user.press(await screen.findByRole('button', { name: /Pool closed/ }));
    await screen.findByTestId('alert-detail-screen');
    expect(screen.queryByRole('button', { name: /Cancel alert|End now|End alert/ })).not.toBeOnTheScreen();
    await expect(app.dependencies.services.alerts.cancel(mine.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(app.content[C]!.alerts![0]).toMatchObject({ status: 'published' });
  });
});

describe('permission differences', () => {
  const can = (role: string) => {
    const keys: Record<string, string[]> = {
      Member: ['members.view', 'posts.create'],
      Moderator: ['members.view', 'members.suspend', 'posts.moderate'],
      Admin: [
        'members.view',
        'members.invite',
        'members.approve',
        'members.suspend',
        'members.remove',
        'announcements.create',
        'alerts.create',
        'events.create',
        'documents.upload',
        'posts.moderate',
        'community.update',
      ],
    };
    return (key: string) => keys[role]!.includes(key);
  };

  test.each([
    ['Member', []],
    ['Moderator', ['members', 'moderation']],
    ['Admin', ['members', 'invite', 'announcement', 'alert', 'events', 'documents', 'moderation', 'profile']],
  ])('%s tools', (role, expected) => {
    expect(adminTools(can(role)).map((t) => t.key)).toEqual(expected);
  });

  test('member actions follow the status and never apply to yourself', () => {
    const all = () => true;
    expect(memberActions({ status: 'pending', isMe: false }, all)).toEqual(['approve', 'reject', 'remove']);
    expect(memberActions({ status: 'active', isMe: false }, all)).toEqual(['suspend', 'remove']);
    expect(memberActions({ status: 'suspended', isMe: false }, all)).toEqual(['reinstate', 'remove']);
    expect(memberActions({ status: 'active', isMe: true }, all)).toEqual([]);
    expect(memberActions({ status: 'left', isMe: false }, all)).toEqual([]);
  });

  test('an Admin manages members but sees no role switches (no roles.manage)', async () => {
    const { user } = await openAdmin('Admin');
    await openMember(user, /^Sarah Member/);
    expect(screen.getByRole('button', { name: 'Remove from community' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Moderator role')).not.toBeOnTheScreen();
    expect(screen.getByTestId('admin-member-role-names')).toHaveTextContent('Member');
  });

  test('permissions, not role names, decide: a custom role with members.invite only gets invitations', async () => {
    await openAdmin('Member', { permissions: { [M]: ['community.view', 'members.view', 'members.invite'] } });
    expect(screen.getByRole('button', { name: 'Invite members' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Members and requests' })).not.toBeOnTheScreen();
  });
});

describe('privilege escalation', () => {
  test('an Admin cannot give roles at all (no roles.manage), even through the service', async () => {
    const app = await renderApp({
      session: makeSession(),
      communities: [{ ...maple, role_names: ['Admin'] }],
      members: people(),
    });
    await screen.findByTestId('feed-screen');
    const { roles } = app.dependencies.services;
    const sarah = app.memberRows[M]![0]!;
    const owner = (await roles.list(M)).find((r) => r.name === 'Owner')!;
    await expect(roles.assign(sarah.membership_id, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sarah.role_names).toEqual(['Member']);
  });

  test('roles.manage without every Owner permission cannot hand out the Owner role', async () => {
    const limited = ['community.view', 'members.view', 'roles.view', 'roles.manage', 'members.suspend'];
    const { user, memberRows } = await openAdmin('Member', { permissions: { [M]: limited } });
    await openMember(user, /^Sarah Member/);
    fireEvent(await screen.findByLabelText('Owner role'), 'valueChange', true);
    expect(await screen.findByTestId('admin-member-error')).toHaveTextContent(
      /only give or take roles whose permissions you hold yourself/,
    );
    expect(memberRows[M]!.find((m) => m.display_name === 'Sarah Member')!.role_names).toEqual(['Member']);
    expect((await screen.findByLabelText('Owner role')).props.value).toBe(false);
  });

  test('an Admin cannot suspend or remove the Owner', async () => {
    const app = await renderApp({
      session: makeSession(),
      communities: [{ ...maple, role_names: ['Admin'] }],
      members: people(),
    });
    await screen.findByTestId('feed-screen');
    const olive = app.memberRows[M]!.find((m) => m.display_name === 'Olive Owner')!;
    const { memberships } = app.dependencies.services;
    await expect(memberships.suspend(olive.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberships.remove(olive.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(olive.status).toBe('active');
  });

  test('nobody changes their own membership through the service', async () => {
    const app = await renderApp({ session: makeSession(), communities: [maple], members: people() });
    await screen.findByTestId('feed-screen');
    const { memberships } = app.dependencies.services;
    await expect(memberships.suspend(maple.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('cross-community authorization', () => {
  test('an Owner of one community has no power in another where she is a Member', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ session: makeSession(), communities: [maple, choir], members: people() });
    await user.press(await screen.findByRole('button', { name: /^St\. Mark Choir/ }));
    await openHub();
    expect(screen.queryByTestId('hub-admin')).not.toBeOnTheScreen();
    const chris = app.memberRows[C]![0]!;
    const { memberships, invitations } = app.dependencies.services;
    await expect(memberships.suspend(chris.membership_id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invitations.create({ communityId: C })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(chris.status).toBe('active');
  });

  test("the admin lists never include another community's members", async () => {
    const { user } = await openAdmin();
    await user.press(screen.getByRole('button', { name: 'Members and requests' }));
    await screen.findByRole('button', { name: /^Sarah Member/ });
    expect(screen.queryByRole('button', { name: /^Chris Choir/ })).not.toBeOnTheScreen();
  });

  test('a membership is tagged with its community, so screens can refuse foreign ones', async () => {
    const app = await renderApp({ session: makeSession(), communities: [maple, choir], members: people() });
    await screen.findByRole('button', { name: /^St\. Mark Choir/ });
    const chris = await app.dependencies.services.memberships.get(app.memberRows[C]![0]!.membership_id);
    expect(chris.communityId).toBe(C);
  });
});

describe('feed timeline', () => {
  test('announcements, events and alerts appear in the feed among the posts', async () => {
    await renderApp({
      session: makeSession(),
      communities: [choir],
      content: {
        [C]: {
          posts: [makePost(C, 1, { body: 'A post' })],
          announcements: [makeAnnouncement(C, 1, { title: 'Rehearsal moved' })],
          events: [makeEvent(C, 1, { title: 'Spring concert' })],
          alerts: [makeAlert(C, 1, { title: 'Parking closed', severity: 'info', severity_rank: 1 })],
        },
      },
    });
    const list = await screen.findByTestId('feed-list');
    expect(await within(list).findByText('A post')).toBeOnTheScreen();
    expect(within(list).getByText('Rehearsal moved')).toBeOnTheScreen();
    expect(within(list).getByText('Spring concert')).toBeOnTheScreen();
    expect(within(list).getByText('Parking closed')).toBeOnTheScreen();
  });

  test('urgent alerts stay pinned above, not repeated in the timeline', async () => {
    await renderApp({
      session: makeSession(),
      communities: [choir],
      content: {
        [C]: { alerts: [makeAlert(C, 1, { title: 'Gas leak', severity: 'urgent', severity_rank: 3 })] },
      },
    });
    await screen.findByTestId('feed-screen');
    expect(await screen.findAllByText('Gas leak')).toHaveLength(1);
    expect(screen.queryByTestId(/^feed-alert-/)).not.toBeOnTheScreen();
  });
});

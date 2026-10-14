// Quick alerts (migration 31) through the whole app (REAL service layer)
// against a fake Supabase applying the database rules: members may send
// alerts (not emergencies), with the location they choose to share and a
// photo from the camera or library (private alert-images bucket, own folder),
// and only alert managers take alerts down.
import { Linking } from 'react-native';
import { screen, userEvent, within } from '@testing-library/react-native';
import { LocationUnavailableError } from '@/lib/location';
import { CameraUnavailableError } from '@/lib/media';
import {
  makeSession,
  makePhoto,
  makeAlert,
  sampleCommunities,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';
import { accuracyLine, presetsFor, QUICK_ALERTS, reachLine } from './quickAlerts';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // Owner
const C = choir.community_id; // Member

/** Signed in (a Member by default), on the Quick alert screen opened from the feed. */
async function openQuickAlert(options: FakeOptions = {}, community: object = choir) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities: [community], ...options });
  await user.press(await screen.findByRole('button', { name: 'Send a quick alert' }));
  await screen.findByTestId('quick-alert-screen');
  return { user, ...app };
}

const sent = (app: { content: Record<string, { alerts?: Record<string, unknown>[] }> }, id = C) =>
  app.content[id]!.alerts![0]!;

describe('sending', () => {
  test('a member picks what is happening and sends it at once', async () => {
    const app = await openQuickAlert();
    const { user } = app;
    expect(screen.getByText(/Call your local emergency number first/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send alert now' })).toBeDisabled();
    await user.press(screen.getByRole('radio', { name: 'Break-in or theft, Urgent' }));
    expect(screen.getByTestId('quick-reach')).toHaveTextContent(/even if they muted alerts/);
    await user.press(screen.getByRole('button', { name: 'Send alert now' }));
    expect(await screen.findByTestId('alert-detail-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('alert-done')).toHaveTextContent(/Alert sent/);
    expect(sent(app)).toMatchObject({
      title: 'Break-in or theft',
      severity: 'urgent',
      status: 'published',
      created_by: makeSession().user.id,
      latitude: null,
      image_path: null,
    });
    expect(String(sent(app).body)).toMatch(/break-in or theft/);
  });

  test('details, the current location and a camera photo go with it', async () => {
    const app = await openQuickAlert();
    const { user, media, location } = app;
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await user.press(screen.getByRole('radio', { name: /^Fallen|^Road hazard/ }));
    await user.type(screen.getByLabelText('Details (optional)'), 'Tree down on Oak Rd near no. 12');
    await user.press(screen.getByRole('button', { name: 'Share my current location' }));
    expect(await screen.findByTestId('quick-location')).toHaveTextContent(/±12 m/);
    expect(location.source.current).toHaveBeenCalledTimes(1);
    media.nextShot(makePhoto(1));
    await user.press(screen.getByRole('button', { name: 'Take photo' }));
    expect(await screen.findByTestId('quick-photo')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Send alert now' }));
    await screen.findByTestId('alert-detail-screen');

    const row = sent(app);
    expect(row).toMatchObject({
      title: 'Road hazard',
      severity: 'warning',
      body: 'Tree down on Oak Rd near no. 12',
      latitude: 51.50136, // rounded to about a metre
      longitude: -0.14189,
      location_accuracy_m: 12,
    });
    expect(String(row.image_path)).toMatch(new RegExp(`^${C}/${makeSession().user.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(app.alertImageFiles.has(String(row.image_path))).toBe(true);

    expect(await screen.findByTestId('alert-photo')).toBeOnTheScreen();
    const where = screen.getByTestId('alert-location');
    expect(where).toHaveTextContent(/Location shared by the sender · ±12 m/);
    await user.press(within(where).getByRole('button', { name: 'Open in Maps' }));
    expect(open).toHaveBeenCalledWith('https://www.google.com/maps/search/?api=1&query=51.50136,-0.14189');
  });

  test('a photo can come from the library instead, and be removed again', async () => {
    const app = await openQuickAlert();
    const { user, media } = app;
    media.nextPhotos([makePhoto(1)]);
    await user.press(screen.getByRole('button', { name: 'Choose photo' }));
    await screen.findByTestId('quick-photo');
    await user.press(screen.getByRole('button', { name: 'Remove photo' }));
    expect(screen.queryByTestId('quick-photo')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('radio', { name: /^Lost or loose animal/ }));
    await user.press(screen.getByRole('button', { name: 'Send alert now' }));
    await screen.findByTestId('alert-detail-screen');
    expect(sent(app).image_path).toBeNull();
    expect(app.alertImageFiles.size).toBe(0);
  });

  test('location is read only on request, and a refusal is explained', async () => {
    const { user, location } = await openQuickAlert();
    expect(location.source.current).not.toHaveBeenCalled();
    location.next(new LocationUnavailableError('denied'));
    await user.press(screen.getByRole('button', { name: 'Share my current location' }));
    expect(await screen.findByTestId('quick-alert-error')).toHaveTextContent(
      /Location permission was not given/,
    );
    expect(screen.queryByTestId('quick-location')).not.toBeOnTheScreen();
  });

  test('a refused camera is explained', async () => {
    const { user, media } = await openQuickAlert();
    media.nextShot(new CameraUnavailableError());
    await user.press(screen.getByRole('button', { name: 'Take photo' }));
    expect(await screen.findByTestId('quick-alert-error')).toHaveTextContent(
      /Camera permission was not given/,
    );
  });

  test('a refused send (rate limit) keeps everything and says why', async () => {
    const app = await openQuickAlert();
    const { user } = app;
    await user.press(screen.getByRole('radio', { name: /^Something else/ }));
    app.failNextQuery({
      code: '53400',
      message: 'rate limit exceeded: at most 20 per 3600 seconds (alert.create)',
    });
    await user.press(screen.getByRole('button', { name: 'Send alert now' }));
    expect(await screen.findByTestId('quick-alert-error')).toBeOnTheScreen();
    expect(screen.getByTestId('quick-alert-screen')).toBeOnTheScreen();
    expect(app.content[C]?.alerts ?? []).toEqual([]);
  });
});

describe('permissions', () => {
  test('members are not offered emergencies; alert managers are', async () => {
    await openQuickAlert();
    expect(screen.queryByRole('radio', { name: /Community emergency/ })).not.toBeOnTheScreen();
    expect(presetsFor(() => false)).toEqual(QUICK_ALERTS);
  });

  test('an Owner can raise a community emergency', async () => {
    const app = await openQuickAlert({}, maple);
    await app.user.press(screen.getByRole('radio', { name: 'Community emergency, Emergency' }));
    await app.user.press(screen.getByRole('button', { name: 'Send alert now' }));
    await screen.findByTestId('alert-detail-screen');
    expect(sent(app, M)).toMatchObject({ severity: 'emergency', status: 'published' });
  });

  test('the backend refuses a member emergency and someone else’s photo, whatever the app sends', async () => {
    const app = await renderApp({ session: makeSession(), communities: [choir] });
    await screen.findByTestId('feed-screen');
    const { alerts } = app.dependencies.services;
    await expect(
      alerts.create({ communityId: C, title: 'Fake', body: 'Panic', severity: 'emergency', publish: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = `${C}/bbbbbbbb-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.jpg`;
    const { error } = await app.dependencies.supabase
      .from('alerts')
      .insert({ community_id: C, title: 'x', body: 'y', image_path: foreign } as never);
    expect(error).toMatchObject({ code: '42501' });
    await expect(
      alerts.create({ communityId: C, title: 'x', body: 'y', location: { latitude: 120, longitude: 0 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(app.content[C]?.alerts ?? []).toEqual([]);
  });

  test('a member cannot take down the alert she sent; only managers can', async () => {
    const app = await openQuickAlert();
    await app.user.press(screen.getByRole('radio', { name: /^Suspicious activity/ }));
    await app.user.press(screen.getByRole('button', { name: 'Send alert now' }));
    await screen.findByTestId('alert-detail-screen');
    const controls = screen.getByTestId('alert-controls');
    expect(within(controls).getByRole('button', { name: 'Edit' })).toBeOnTheScreen();
    for (const name of ['End now', 'Cancel alert', 'Archive'])
      expect(within(controls).queryByRole('button', { name })).not.toBeOnTheScreen();
    await expect(app.dependencies.services.alerts.cancel(String(sent(app).id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test("outsiders never get the photo of another community's alert", async () => {
    const photo = `${C}/bbbbbbbb-0000-4000-8000-000000000002/11111111-1111-4111-8111-111111111111.jpg`;
    const app = await renderApp({
      session: makeSession(),
      communities: [maple],
      content: { [C]: { alerts: [makeAlert(C, 1, { image_path: photo })] } },
    });
    await screen.findByTestId('feed-screen');
    app.alertImageFiles.set(photo, 'bbbbbbbb-0000-4000-8000-000000000002');
    await expect(app.dependencies.services.alerts.imageUrl({ image_path: photo })).resolves.toBeNull();
  });

  test('without alerts.create there is no quick alert anywhere', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      permissions: { [C]: ['community.view', 'members.view', 'alerts.view', 'posts.view', 'posts.create'] },
    });
    await screen.findByTestId('feed-screen');
    expect(screen.queryByRole('button', { name: 'Send a quick alert' })).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByTestId('create-screen')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Quick alert' })).not.toBeOnTheScreen();
  });
});

describe('rules', () => {
  test('reach and accuracy lines', () => {
    expect(reachLine('urgent', 'Oak St')).toMatch(/even if they muted/);
    expect(reachLine('info', 'Oak St')).toMatch(/who get alerts/);
    expect(accuracyLine(12.4)).toBe('±12 m');
    expect(accuracyLine(null)).toBeNull();
  });
});

// The floating "+" (Create): above the tab bar, not a tab; on the main screen
// of Home, Communities and Discover only, never over a post or an editor.
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { makePost, makeSession, sampleCommunities } from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

const choir = sampleCommunities[1]!;
const C = choir.community_id;

async function start() {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    content: { [C]: { posts: [makePost(C, 1, { body: 'Choir trip', comment_count: 1 })] } },
  });
  await screen.findByText('Choir trip');
  return { user, ...app };
}

test('floats above the tab bar; the bar keeps five tabs', async () => {
  await start();
  expect(screen.getByTestId('fab-create')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Create' })).toBe(screen.getByTestId('fab-create'));
  for (const name of [/^Home/, /^Communities/, /^Discover/, /^Market/, /^Profile/]) {
    expect(screen.getByRole('button', { name })).toBeOnTheScreen();
  }
});

test('opens the Create sheet', async () => {
  const { user } = await start();
  await user.press(screen.getByTestId('fab-create'));
  expect(await screen.findByTestId('create-screen')).toBeOnTheScreen();
});

test('shows on Home, Communities and Discover; not on Market or Profile', async () => {
  const { user } = await start();
  await user.press(screen.getByRole('button', { name: /^Communities/ }));
  await screen.findByTestId('community-home-screen');
  expect(screen.getByTestId('fab-create')).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: /^Discover/ }));
  await screen.findByTestId('discover-screen');
  expect(screen.getByTestId('fab-create')).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: /^Market/ }));
  await waitFor(() => expect(screen.queryByTestId('fab-create')).not.toBeOnTheScreen());
  await user.press(screen.getByRole('button', { name: /^Profile/ }));
  await screen.findByTestId('profile-screen');
  expect(screen.queryByTestId('fab-create')).not.toBeOnTheScreen();
});

test('hides on screens opened from the feed (a post, the editor)', async () => {
  const { user } = await start();
  await user.press(screen.getByRole('button', { name: /comments?\. Open comments$/ }));
  await screen.findByTestId('post-detail-screen');
  await waitFor(() => expect(screen.queryByTestId('fab-create')).not.toBeOnTheScreen());
  await user.press(screen.getByRole('button', { name: /^Home/ }));
  await waitFor(() => expect(screen.getByTestId('fab-create')).toBeOnTheScreen());
  await user.press(screen.getByRole('button', { name: 'New post' }));
  await screen.findByTestId('post-editor-screen');
  expect(screen.queryByTestId('fab-create')).not.toBeOnTheScreen();
});

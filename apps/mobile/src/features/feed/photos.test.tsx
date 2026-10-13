// The redesigned Home feed and photo posts, through the whole app (REAL
// service layer) against a fake Supabase that applies migration 26: private
// post-images bucket (own-folder uploads, reads follow the post), and the
// atomic, idempotent create_post().
import { screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  makeAlert,
  makePhoto,
  makePost,
  makePostImage,
  makeSession,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';
import { frameAspect, MAX_ASPECT, MIN_ASPECT } from './components/PostImageGallery';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;
type Content = Record<string, { posts?: Record<string, unknown>[]; postImages?: Record<string, unknown>[] }>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // the user is the Owner (moderator)
const C = choir.community_id; // the user is a Member

const garden = makePost(C, 1, {
  body: 'Garden day!',
  author_user_id: OTHER_USER_ID,
  author_display_name: 'Grace H.',
});
const gardenImages = [
  makePostImage(C, garden.id, 1, { position: 0, width: 1080, height: 1350 }),
  makePostImage(C, garden.id, 2, { position: 1, width: 1920, height: 1080 }),
  makePostImage(C, garden.id, 3, { position: 2, width: 1080, height: 1080 }),
];
const words = makePost(C, 2, { body: 'Just words', author_user_id: OTHER_USER_ID });

async function openHome(options: FakeOptions = {}) {
  const user = userEvent.setup();
  // Fresh copies: tests change rows on the "server".
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    ...options,
    content: structuredClone(
      options.content ?? { [C]: { posts: [garden, words], postImages: gardenImages } },
    ),
  });
  await screen.findByTestId('feed-screen');
  await waitFor(() => expect(screen.queryByText('Loading posts…')).not.toBeOnTheScreen());
  return { user, ...app, content: app.content as Content };
}

const cardOf = (body: string) => {
  let node = screen.getByText(body) as unknown as { parent: unknown; props: { testID?: string } } | null;
  while (node && !/^post-[0-9a-f]{8}-/.test(String(node.props.testID ?? '')))
    node = node.parent as typeof node;
  return node as unknown as Parameters<typeof within>[0];
};
const postsBy = (content: Content, body: string) =>
  Object.values(content)
    .flatMap((c) => c.posts ?? [])
    .filter((p) => p.body === body);

async function compose(user: User, caption: string) {
  await user.press(screen.getByRole('button', { name: 'Add photos' }));
  await screen.findByTestId('post-editor-screen');
  await screen.findByTestId('composer-photo-0');
  await user.type(screen.getByLabelText('What would you like to share?'), caption);
}

describe('the Home tab is the feed', () => {
  test('five tabs; Home shows the current community with a switcher, a create button and the prompt', async () => {
    const { user } = await openHome();
    for (const name of [/^Home/, /^Communities/, /^Marketplace/, /^Alerts/, /^Profile/]) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
    expect(screen.getByLabelText('Switch community. Current community: St. Mark Choir')).toBeOnTheScreen();
    expect(screen.getByText('Current community')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'New post' })).toBeOnTheScreen();
    expect(screen.getByText('Share with your community')).toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: /^Marketplace/ }));
    expect(await screen.findByText('Marketplace is coming soon')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: /^Alerts/ }));
    expect(await screen.findByTestId('alerts-screen')).toBeOnTheScreen();
  });

  test('the background is white and the text near-black', async () => {
    await openHome();
    expect(StyleSheet.flatten(screen.getByTestId('feed-screen').props.style)).toMatchObject({
      backgroundColor: '#FFFFFF',
    });
    expect(StyleSheet.flatten(screen.getByText('Just words').props.style)).toMatchObject({
      color: '#121417',
    });
  });

  test('urgent and emergency alerts in force stay above the posts; others do not', async () => {
    const { user } = await openHome({
      content: {
        [C]: {
          posts: [words],
          alerts: [
            makeAlert(C, 1, {
              title: 'Gas leak',
              severity: 'emergency',
              severity_rank: 4,
              is_emergency: true,
            }),
            makeAlert(C, 2, { title: 'Bin day moved', severity: 'info', severity_rank: 1 }),
          ],
        },
      },
    });
    const pinned = await screen.findByTestId('feed-alerts');
    expect(within(pinned).getByLabelText(/^Emergency alert: Gas leak/)).toBeOnTheScreen();
    expect(within(pinned).queryByText('Bin day moved')).not.toBeOnTheScreen();
    await user.press(within(pinned).getByLabelText(/^Emergency alert: Gas leak/));
    expect(await screen.findByTestId('alert-detail-screen')).toBeOnTheScreen();
  });
});

describe('photos in the feed', () => {
  test('a post shows its photos, in order, with a counter and descriptions for screen readers', async () => {
    await openHome();
    const card = cardOf('Garden day!');
    const gallery = within(card).getByTestId('post-gallery');
    expect(within(gallery).getByLabelText('Photo 1 of 3, posted by Grace H.').props.source.uri).toContain(
      gardenImages[0]!.storage_path,
    );
    expect(within(gallery).getByLabelText('Photo 3 of 3, posted by Grace H.')).toBeOnTheScreen();
    expect(within(card).getByText('1/3')).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'React with Like' })).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: /comments?\. Open comments$/ })).toBeOnTheScreen();
    // A text post has no gallery.
    expect(within(cardOf('Just words')).queryByTestId('post-gallery')).not.toBeOnTheScreen();
  });

  test("the frame takes the photo's shape: portrait, square and landscape, never cropped beyond 4:5 … 1.91:1", () => {
    expect(frameAspect([{ width: 1080, height: 1350 }])).toBeCloseTo(0.8);
    expect(frameAspect([{ width: 1080, height: 1080 }])).toBe(1);
    expect(frameAspect([{ width: 1920, height: 1080 }])).toBeCloseTo(1.778, 2);
    expect(frameAspect([{ width: 4000, height: 1000 }])).toBe(MAX_ASPECT);
    expect(frameAspect([{ width: 1000, height: 3000 }])).toBe(MIN_ASPECT);
  });

  test('a photo that cannot be loaded says so instead of breaking the post', async () => {
    const lost = makePostImage(C, words.id, 9, { file_missing: true });
    await openHome({ content: { [C]: { posts: [words], postImages: [lost] } } });
    const card = cardOf('Just words');
    expect(await within(card).findByTestId('post-image-0-unavailable')).toBeOnTheScreen();
    expect(within(card).getByText('Photo unavailable')).toBeOnTheScreen();
    expect(within(card).getByText('Just words')).toBeOnTheScreen();
  });

  test("the author's profile picture is shown when they have one", async () => {
    const own = makePost(C, 3, {
      body: 'My photo',
      author_user_id: TEST_USER_ID,
      author_display_name: 'Ada L.',
    });
    await openHome({
      profile: { avatar_path: `${TEST_USER_ID}/11111111-1111-4111-8111-111111111111.jpg` },
      content: { [C]: { posts: [own] } },
    });
    const avatar = await within(cardOf('My photo')).findByTestId('post-author-image');
    expect(avatar.props.source.uri).toContain('avatars');
  });
});

describe('creating a post with photos', () => {
  test('pick, preview, remove one, caption, publish: the post appears with its photo', async () => {
    const { user, media, rpc, postImagesStorage, content } = await openHome();
    media.nextPhotos([makePhoto(1, 1080, 1350), makePhoto(2, 1920, 1080)]);
    await compose(user, 'Our new benches');
    expect(screen.getByTestId('composer-photo-1')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(screen.queryByTestId('composer-photo-1')).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Post' }));
    await screen.findByTestId('feed-screen');
    await waitFor(() => expect(screen.getByText('Our new benches')).toBeOnTheScreen());

    // One upload (the removed photo was never sent), into the user's own folder of this community.
    expect(postImagesStorage.upload).toHaveBeenCalledTimes(1);
    expect(postImagesStorage.upload.mock.calls[0]![0]).toMatch(
      new RegExp(`^${C}/${TEST_USER_ID}/[0-9a-f-]{36}\\.jpg$`),
    );
    const create = rpc.mock.calls.find(([n]) => n === 'create_post')![1] as Record<string, unknown>;
    expect(create).toMatchObject({ p_community_id: C, p_body: 'Our new benches' });
    expect(create.p_images).toEqual([{ path: expect.any(String), width: 1920, height: 1080 }]);
    expect(create.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);
    const [created] = postsBy(content, 'Our new benches');
    expect(created).toMatchObject({ author_user_id: TEST_USER_ID, community_id: C });
    expect(
      within(await waitFor(() => cardOf('Our new benches'))).getByTestId('post-gallery'),
    ).toBeOnTheScreen();
  });

  test('a text-only post works from the header button', async () => {
    const { user, content } = await openHome();
    await user.press(screen.getByRole('button', { name: 'New post' }));
    await user.type(await screen.findByLabelText('What would you like to share?'), 'No photos today');
    await user.press(screen.getByRole('button', { name: 'Post' }));
    await screen.findByTestId('feed-screen');
    expect(await screen.findByText('No photos today')).toBeOnTheScreen();
    expect(postsBy(content, 'No photos today')).toHaveLength(1);
  });

  test('a failed upload keeps the caption and photos; "Try again" finishes without re-sending what was uploaded', async () => {
    const { user, media, postImagesStorage, failUploads, content } = await openHome();
    media.nextPhotos([makePhoto(1), makePhoto(2)]);
    await compose(user, 'Spring fair');
    failUploads(1);
    await user.press(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByTestId('post-editor-error')).toHaveTextContent(/A photo could not be uploaded/);
    expect(screen.getByLabelText('What would you like to share?')).toHaveDisplayValue('Spring fair');
    expect(screen.getByLabelText('Photo 1 of 2, upload failed')).toBeOnTheScreen();
    expect(postsBy(content, 'Spring fair')).toHaveLength(0);

    await user.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('feed-screen');
    // 1 failed + 2 successful uploads; one post.
    expect(postImagesStorage.upload).toHaveBeenCalledTimes(3);
    expect(postsBy(content, 'Spring fair')).toHaveLength(1);
  });

  test('a publish whose answer was lost is retried without creating a duplicate post', async () => {
    const { user, media, rpc, content } = await openHome();
    media.nextPhotos([makePhoto(1)]);
    await compose(user, 'Only once');
    // The server creates the post, but the answer never reaches the phone.
    const real = rpc.getMockImplementation()!;
    let dropped = false;
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      const result = await real(name, args);
      if (name === 'create_post' && !dropped) {
        dropped = true;
        return { data: null, error: { code: '', message: 'TypeError: Network request failed', status: 0 } };
      }
      return result;
    });
    await user.press(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByTestId('post-editor-error')).toHaveTextContent(/nothing will be posted twice/);
    expect(postsBy(content, 'Only once')).toHaveLength(1);

    await user.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('feed-screen');
    const ids = rpc.mock.calls
      .filter(([n]) => n === 'create_post')
      .map(([, a]) => (a as { p_client_request_id: string }).p_client_request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(postsBy(content, 'Only once')).toHaveLength(1);
  });

  test('limits: at most 10 photos; photos over 10 MB are left out with a note', async () => {
    const { user, media } = await openHome();
    const big = { ...makePhoto(99), bytes: new Uint8Array(10 * 1024 * 1024 + 1) };
    media.nextPhotos([...Array.from({ length: 9 }, (_, i) => makePhoto(i)), big]);
    await compose(user, 'Lots');
    expect(await screen.findByTestId('post-editor-notice')).toHaveTextContent(/too large/);
    expect(screen.getByTestId('composer-photo-8')).toBeOnTheScreen();
    media.nextPhotos([makePhoto(20), makePhoto(21)]);
    await user.press(screen.getByRole('button', { name: 'Add more photos' }));
    await screen.findByTestId('composer-photo-9');
    expect(media.picker.pickPhotos).toHaveBeenLastCalledWith(1);
    expect(screen.queryByTestId('composer-photo-10')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Add more photos' })).toBeDisabled();
  });

  test('editing a photo post changes the caption only; its photos stay', async () => {
    const own = makePost(C, 4, {
      body: 'Before',
      author_user_id: TEST_USER_ID,
      author_display_name: 'Ada L.',
    });
    const image = makePostImage(C, own.id, 7, {
      storage_path: `${C}/${TEST_USER_ID}/77777777-7777-4777-8777-777777777777.jpg`,
    });
    const { user, queries } = await openHome({ content: { [C]: { posts: [own], postImages: [image] } } });
    await user.press(within(cardOf('Before')).getByRole('button', { name: 'Post options' }));
    await user.press(within(cardOf('Before')).getByRole('button', { name: 'Edit post' }));
    expect(await screen.findByText(/Photos can't be changed after posting/)).toBeOnTheScreen();
    const field = screen.getByLabelText('Your post');
    await user.clear(field);
    await user.type(field, 'After');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('After')).toBeOnTheScreen();
    expect(within(cardOf('After')).getByTestId('post-gallery')).toBeOnTheScreen();
    expect(queries.find((q) => q.table === 'posts' && q.op === 'update')?.values).toEqual({ body: 'After' });
  });
});

describe('who may post and see photos', () => {
  test('without posts.create: no create button, no prompt, and the backend refuses uploads and posts', async () => {
    const { dependencies, content } = await openHome({ permissions: { [C]: ['posts.view'] } });
    expect(screen.queryByRole('button', { name: 'New post' })).not.toBeOnTheScreen();
    expect(screen.queryByText('Share with your community')).not.toBeOnTheScreen();
    const { posts } = dependencies.services;
    await expect(
      posts.uploadImage({ communityId: C, file: makePhoto(1).bytes, mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(posts.create({ communityId: C, body: 'Sneaky' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(postsBy(content, 'Sneaky')).toHaveLength(0);
  });

  test("another community's photos can be neither listed nor signed; pictures cannot be borrowed", async () => {
    const mapleImage = makePostImage(M, 'd4d4d4d4-0000-4000-8000-000000000099', 50);
    const { dependencies } = await openHome({
      content: {
        [C]: { posts: [garden], postImages: gardenImages },
        [M]: { posts: [makePost(M, 99, { body: 'Maple secret' })], postImages: [mapleImage] },
      },
    });
    const { posts } = dependencies.services;
    expect(await posts.images(['d4d4d4d4-0000-4000-8000-000000000099'])).toEqual({});
    // Someone else's upload cannot be attached to my post.
    await expect(
      posts.create({
        communityId: C,
        body: 'Borrowed',
        images: [{ path: gardenImages[0]!.storage_path, width: 1, height: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('a post hidden by a moderator takes its photos with it for members', async () => {
    const { dependencies, content } = await openHome();
    content[C]!.posts!.find((p) => p.id === garden.id)!.status = 'hidden';
    expect(await dependencies.services.posts.images([garden.id])).toEqual({});
  });

  test("switching community shows only the new community's posts and photos, nothing stale", async () => {
    const user = userEvent.setup();
    const mapleNews = makePost(M, 5, { body: 'Maple news' });
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: structuredClone({
        [C]: { posts: [garden], postImages: gardenImages },
        [M]: { posts: [mapleNews], postImages: [makePostImage(M, mapleNews.id, 60)] },
      }),
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    expect(await screen.findByText('Garden day!')).toBeOnTheScreen();
    await user.press(screen.getByTestId('feed-community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    expect(await screen.findByText('Maple news')).toBeOnTheScreen();
    expect(screen.queryByText('Garden day!')).not.toBeOnTheScreen();
    await waitFor(() => expect(screen.getAllByLabelText(/^Photo 1 of 1/)).toHaveLength(1));
    for (const image of screen.getAllByLabelText(/^Photo \d+ of \d+/)) {
      expect(image.props.source.uri).toContain(`/post-images/${M}/`);
    }
  });
});

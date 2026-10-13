// Stories through the whole app (REAL service layer) against a fake Supabase
// applying migration 27's rules: active stories only (not expired or
// deleted), posts.view to see, posts.create to add (own folder only),
// per-viewer seen state, counts for authors only, delete by the author or a
// moderator, and the private stories bucket (signed links for visible ones).
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makePhoto,
  makeSession,
  makeStory,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // the user is the Owner (posts.moderate)
const C = choir.community_id; // the user is a Member
const JAMES = 'dddddddd-0000-4000-8000-000000000003';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const choirStories = () => [
  makeStory(C, 1, { caption: 'Garden day!', created_at: hoursAgo(3) }),
  makeStory(C, 2, { caption: 'Tomatoes', created_at: hoursAgo(2) }),
  makeStory(C, 3, { author_user_id: JAMES, author_display_name: 'James Park', created_at: hoursAgo(1) }),
  // Not shown: expired, deleted.
  makeStory(C, 4, {
    author_user_id: JAMES,
    created_at: hoursAgo(30),
    expires_at: hoursAgo(6),
    caption: 'Old',
  }),
  makeStory(C, 5, { deleted_at: hoursAgo(1), caption: 'Removed' }),
];

/** Signed in with one community, on the feed. */
async function openFeed(options: FakeOptions = {}, communities: unknown[] = [choir]) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities,
    content: {
      [C]: { stories: choirStories() },
      [M]: { stories: [makeStory(M, 9, { caption: 'Maple only' })] },
    },
    ...options,
  });
  await screen.findByTestId('feed-screen');
  await screen.findByTestId('stories-bar');
  return { user, ...app };
}

const bubbles = () =>
  within(screen.getByTestId('stories-bar'))
    .getAllByRole('button')
    .map((b) => b.props.accessibilityLabel as string);

async function openStory(user: User, name: RegExp | string) {
  await user.press(await screen.findByRole('button', { name }));
  return screen.findByTestId('story-viewer');
}

describe('the stories bar', () => {
  test('your story first, then members with new stories; nothing expired, deleted or from another community', async () => {
    await openFeed();
    await waitFor(() =>
      expect(bubbles()).toEqual([
        'Add to your story',
        'Story by James Park, new',
        'Story by Grace Hopper, new',
      ]),
    );
    expect(screen.queryByText('Maple only')).not.toBeOnTheScreen();
    expect(within(screen.getByTestId('stories-bar')).getByText('James')).toBeOnTheScreen();
  });

  test('without posts.create there is nothing to add', async () => {
    await openFeed({ permissions: { [C]: ['posts.view'] } });
    await waitFor(() =>
      expect(bubbles()).toEqual(['Story by James Park, new', 'Story by Grace Hopper, new']),
    );
    expect(screen.queryByRole('button', { name: 'Add to your story' })).not.toBeOnTheScreen();
  });

  test('without posts.view there are no stories at all', async () => {
    await renderApp({
      session: makeSession(),
      communities: [choir],
      permissions: { [C]: [] },
      content: { [C]: { stories: choirStories() } },
    });
    await screen.findByTestId('feed-screen');
    expect(screen.queryByTestId('stories-bar')).not.toBeOnTheScreen();
  });
});

describe('viewing', () => {
  test('a story opens full screen through a signed link and is marked seen; next, previous, next author, close', async () => {
    const { user, rpc, storiesStorage } = await openFeed();
    await openStory(user, 'Story by Grace Hopper, new');
    expect(screen.getByTestId('story-author')).toHaveTextContent('Grace Hopper');
    expect(screen.getByTestId('story-caption')).toHaveTextContent('Garden day!');
    expect(screen.getByTestId('story-image').props.source.uri).toMatch(
      /^https:\/\/storage\.test\/stories\/.+\?expires=600$/,
    );
    expect(storiesStorage.createSignedUrls).toHaveBeenCalled();
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('mark_story_viewed', { p_story_id: choirStories()[0]!.id }),
    );
    // No count and no delete on someone else's story (a member is not a moderator).
    expect(screen.queryByTestId('story-views')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Delete this story' })).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Next story' }));
    expect(screen.getByTestId('story-caption')).toHaveTextContent('Tomatoes');
    await user.press(screen.getByRole('button', { name: 'Previous story' }));
    expect(screen.getByTestId('story-caption')).toHaveTextContent('Garden day!');
    await user.press(screen.getByRole('button', { name: 'Next story' }));
    await user.press(screen.getByRole('button', { name: 'Next story' }));
    // Grace's last story was the end of this run (James's came first in the bar).
    await waitFor(() => expect(screen.queryByTestId('story-viewer')).not.toBeOnTheScreen());
    // Back on the feed, Grace's stories are now seen.
    await waitFor(() => expect(bubbles()).toContain('Story by Grace Hopper, seen'));
  });

  test('from the first author, the viewer moves on to the next one', async () => {
    const { user } = await openFeed();
    await openStory(user, 'Story by James Park, new');
    expect(screen.getByTestId('story-author')).toHaveTextContent('James Park');
    await user.press(screen.getByRole('button', { name: 'Next story' }));
    expect(screen.getByTestId('story-author')).toHaveTextContent('Grace Hopper');
    await user.press(screen.getByRole('button', { name: 'Close stories' }));
    await waitFor(() => expect(screen.queryByTestId('story-viewer')).not.toBeOnTheScreen());
  });

  test('a story deleted meanwhile is not shown', async () => {
    const { user, content } = await openFeed();
    for (const story of content[C]!.stories!)
      if (story.author_user_id === JAMES) story.deleted_at = hoursAgo(0);
    await openStory(user, 'Story by James Park, new');
    expect(await screen.findByTestId('story-gone')).toHaveTextContent(/no longer available/);
  });

  test('your own story shows how many saw it, and you can delete it', async () => {
    const mine = makeStory(C, 6, {
      author_user_id: TEST_USER_ID,
      author_display_name: 'Ada L.',
      view_count: 2,
    });
    const { user, rpc } = await openFeed({
      content: { [C]: { stories: [mine, ...choirStories()] } },
    });
    await waitFor(() => expect(bubbles()[0]).toBe('Your story'));
    await openStory(user, 'Your story');
    expect(screen.getByTestId('story-author')).toHaveTextContent('Your story');
    expect(screen.getByTestId('story-views')).toHaveTextContent('Seen by 2');
    await user.press(screen.getByRole('button', { name: 'Delete this story' }));
    await user.press(screen.getByRole('button', { name: 'Delete story' }));
    // Gone: the viewer moves on to the next author's stories.
    await waitFor(() => expect(screen.getByTestId('story-author')).not.toHaveTextContent('Your story'));
    expect(rpc).toHaveBeenCalledWith('delete_story', { p_story_id: mine.id });
    await user.press(screen.getByRole('button', { name: 'Close stories' }));
    await waitFor(() => expect(bubbles()[0]).toBe('Add to your story'));
    expect(bubbles()).toHaveLength(3);
  });

  test('a moderator can delete a member’s story; a member cannot (the server refuses)', async () => {
    const mapleStories = [makeStory(M, 7, { caption: 'Off topic' })];
    const { user } = await openFeed({ content: { [M]: { stories: mapleStories } } }, [maple]);
    await openStory(user, 'Story by Grace Hopper, new');
    await user.press(screen.getByRole('button', { name: 'Delete this story' }));
    await user.press(screen.getByRole('button', { name: 'Delete story' }));
    await waitFor(() => expect(mapleStories[0]!.deleted_at).not.toBeNull());
  });

  test('hidden buttons are not the protection: a member’s delete is refused by the backend', async () => {
    const { dependencies } = await openFeed();
    await expect(dependencies.services.stories.delete(choirStories()[0]!.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Another community's story cannot even be seen.
    expect(await dependencies.services.stories.delete(makeStory(M, 9).id)).toBe(false);
    expect(await dependencies.services.stories.markViewed(makeStory(M, 9).id)).toBe(false);
  });
});

describe('adding a story', () => {
  test('choose a photo, add a caption, share: uploaded to your own folder, then published once', async () => {
    const { user, media, rpc, storiesStorage, content } = await openFeed();
    await user.press(await screen.findByRole('button', { name: 'Add to your story' }));
    await screen.findByTestId('story-composer');
    expect(screen.getByText('Shared with St. Mark Choir for 24 hours.')).toBeOnTheScreen();
    media.nextPhotos([makePhoto(1, 1080, 1920)]);
    await user.press(screen.getByRole('button', { name: 'Choose a photo' }));
    expect(await screen.findByTestId('story-preview')).toBeOnTheScreen();
    await user.type(screen.getByLabelText('Caption (optional)'), 'Sunset from the hall');
    await user.press(screen.getByRole('button', { name: 'Share story' }));
    await waitFor(() => expect(screen.queryByTestId('story-composer')).not.toBeOnTheScreen());

    const [path] = storiesStorage.upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${C}/${TEST_USER_ID}/[0-9a-f-]{36}\\.jpg$`));
    const [, args] = rpc.mock.calls.find(([n]) => n === 'create_story')!;
    expect(args).toMatchObject({
      p_community_id: C,
      p_path: path,
      p_width: 1080,
      p_height: 1920,
      p_caption: 'Sunset from the hall',
    });
    expect(content[C]!.stories!.filter((s) => s.author_user_id === TEST_USER_ID)).toHaveLength(1);
    await waitFor(() => expect(bubbles()[0]).toBe('Your story'));
  });

  test('a failed publish keeps the photo; "Try again" does not upload twice or duplicate', async () => {
    const { user, media, failRpcOnce, storiesStorage, content } = await openFeed();
    await user.press(await screen.findByRole('button', { name: 'Add to your story' }));
    media.nextPhotos([makePhoto(2)]);
    await user.press(await screen.findByRole('button', { name: 'Choose a photo' }));
    failRpcOnce('create_story');
    await user.press(screen.getByRole('button', { name: 'Share story' }));
    expect(await screen.findByTestId('story-composer-error')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByTestId('story-composer')).not.toBeOnTheScreen());
    expect(storiesStorage.upload).toHaveBeenCalledTimes(1);
    expect(content[C]!.stories!.filter((s) => s.author_user_id === TEST_USER_ID)).toHaveLength(1);
  });

  test('without permission the server refuses the upload', async () => {
    const { dependencies } = await openFeed({ permissions: { [C]: ['posts.view'] } });
    await expect(
      dependencies.services.stories.uploadImage({
        communityId: C,
        file: makePhoto(3).bytes,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Nor into someone else's folder, even with posts.create.
    await expect(
      dependencies.services.stories.create({
        communityId: C,
        path: `${C}/${OTHER_USER_ID}/${'a'.repeat(8)}-0000-4000-8000-000000000000.jpg`,
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('leaving after the upload without sharing discards the photo', async () => {
    const { user, media, failRpcOnce, storiesStorage } = await openFeed();
    await user.press(await screen.findByRole('button', { name: 'Add to your story' }));
    media.nextPhotos([makePhoto(4)]);
    await user.press(await screen.findByRole('button', { name: 'Choose a photo' }));
    failRpcOnce('create_story');
    await user.press(screen.getByRole('button', { name: 'Share story' }));
    await screen.findByTestId('story-composer-error');
    // Leave without sharing (closing the modal unmounts it).
    await act(async () => screen.unmount());
    const [path] = storiesStorage.upload.mock.calls[0]!;
    expect(storiesStorage.remove).toHaveBeenCalledWith([path]);
  });
});

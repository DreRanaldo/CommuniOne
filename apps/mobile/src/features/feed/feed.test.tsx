// The community feed through the whole app (navigation, providers and the
// REAL service layer) against a fake Supabase that applies the posts rules:
// RLS visibility (published / hidden / deleted), posts.create, edit and delete
// of one's own posts, keyset pagination.
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makePost,
  makeSession,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
/** The user is a plain Member here (no moderation). */
const C = choir.community_id;
const M = maple.community_id;

const mine = (n: number, overrides: Record<string, unknown> = {}) =>
  makePost(C, n, {
    author_user_id: TEST_USER_ID,
    author_display_name: 'Ada L.',
    body: `My post ${n}`,
    ...overrides,
  });
const theirs = (n: number, overrides: Record<string, unknown> = {}) =>
  makePost(C, n, {
    author_user_id: OTHER_USER_ID,
    author_display_name: 'Grace H.',
    body: `Their post ${n}`,
    ...overrides,
  });

const listCalls = (rpc: jest.Mock) =>
  rpc.mock.calls
    .filter(([name]) => name === 'list_community_posts')
    .map(
      ([, args]) =>
        args as { p_community_id: string; p_limit: number; p_cursor_created_at?: string; p_status: string },
    );

/** Signed in with the choir: Home is its feed. */
async function openFeed(options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    content: { [C]: { posts: [mine(1), theirs(2)] } },
    ...options,
  });
  await screen.findByTestId('feed-screen');
  await waitFor(() => expect(screen.queryByText('Loading posts…')).not.toBeOnTheScreen());
  return { user, ...app };
}

/** Reaches the end of the list: the next page is requested (the footer button is the accessible path). */
const loadMore = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.press(await screen.findByRole('button', { name: 'Load more posts' }));
};

type Node = { props: Record<string, unknown>; children: (Node | string)[] };
const findNode = (node: Node, match: (n: Node) => boolean): Node | undefined => {
  if (match(node)) return node;
  for (const child of node.children) {
    const found = typeof child === 'string' ? undefined : findNode(child, match);
    if (found) return found;
  }
  return undefined;
};
const pullToRefresh = async () => {
  const list = findNode(
    screen.getByTestId('feed-screen') as unknown as Node,
    (n) => !!n.props.refreshControl,
  )!;
  await act(async () => (list.props.refreshControl as { props: { onRefresh(): void } }).props.onRefresh());
};

const post = (body: string) => screen.getByText(body);
/** Opens a post's "…" menu (edit, delete and moderation live there). */
const openMenu = async (user: ReturnType<typeof userEvent.setup>, body: string) =>
  user.press(within(cardOf(body)).getByRole('button', { name: 'Post options' }));
const cardOf = (body: string) => {
  let node = post(body) as unknown as { parent: unknown; props: { testID?: string } } | null;
  while (node && !/^post-[0-9a-f]{8}-/.test(String(node.props.testID ?? '')))
    node = node.parent as typeof node;
  return node as unknown as Parameters<typeof within>[0];
};

describe('feed loading', () => {
  test("shows the community's posts with author, time, body, reactions and comments", async () => {
    const { rpc } = await openFeed({
      content: {
        [C]: {
          posts: [
            theirs(1, { reaction_count: 3, comment_count: 2, edited_at: '2026-10-12T11:00:00Z' }),
            makePost(C, 2, {
              author_user_id: null,
              author_display_name: null,
              body: 'From a deleted account',
            }),
          ],
        },
      },
    });
    const card = cardOf('Their post 1');
    expect(within(card).getByText('Grace H.')).toBeOnTheScreen();
    expect(within(card).getByText(/· Edited/)).toBeOnTheScreen();
    expect(await within(card).findByLabelText('3 Like')).toBeOnTheScreen();
    expect(within(card).getByLabelText('2 comments. Open comments')).toBeOnTheScreen();
    expect(within(cardOf('From a deleted account')).getByText('Deleted User')).toBeOnTheScreen();
    // (The community home asked for its 3-post summary first.)
    const feedCall = listCalls(rpc).find((c) => c.p_limit === 20);
    expect(feedCall).toMatchObject({ p_community_id: C, p_limit: 20, p_status: 'published' });
  });

  test('empty feed: an invitation to write the first post', async () => {
    const { user } = await openFeed({ content: {} });
    expect(await screen.findByText('No posts yet')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Write the first post' }));
    expect(await screen.findByTestId('post-editor-screen')).toBeOnTheScreen();
  });

  test('a failure shows a safe error with retry', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      content: { [C]: { posts: [theirs(1)] } },
      failFirstRpcNamed: 'list_community_posts',
    });
    expect(await screen.findByText('Posts could not be loaded')).toBeOnTheScreen();
    expect(screen.queryByText(/postgresql/)).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Their post 1')).toBeOnTheScreen();
  });

  test('the feed is never loaded whole: 20 posts per request', async () => {
    const posts = Array.from({ length: 45 }, (_, i) => theirs(i + 1));
    const { rpc } = await openFeed({ content: { [C]: { posts } } });
    expect(screen.getByText('Their post 1')).toBeOnTheScreen();
    expect(screen.queryByText('Their post 21')).not.toBeOnTheScreen();
    expect(
      listCalls(rpc).filter((c) => c.p_community_id === C && c.p_status === 'published').length,
    ).toBeGreaterThan(0);
    expect(listCalls(rpc).every((c) => c.p_limit <= 20)).toBe(true);
  });
});

describe('pagination', () => {
  test('the next page is requested with the backend cursor at the end of the list', async () => {
    // (FlatList renders only its first rows in tests: pages are checked through the requests.)
    const posts = Array.from({ length: 45 }, (_, i) => theirs(i + 1));
    const { rpc, user } = await openFeed({ content: { [C]: { posts } } });
    const feedCalls = () => listCalls(rpc).filter((c) => c.p_limit === 20);
    expect(feedCalls()).toHaveLength(1);
    expect(feedCalls()[0]!.p_cursor_created_at).toBeUndefined();

    await loadMore(user);
    await waitFor(() => expect(feedCalls()).toHaveLength(2));
    expect(feedCalls()[1]!.p_cursor_created_at).toBe(posts[19]!.created_at);

    await loadMore(user);
    await waitFor(() => expect(feedCalls()).toHaveLength(3));
    expect(feedCalls()[2]!.p_cursor_created_at).toBe(posts[39]!.created_at);
    expect(await screen.findByText("You're all caught up.")).toBeOnTheScreen();
    // At the end: nothing more to request.
    expect(screen.queryByRole('button', { name: 'Load more posts' })).not.toBeOnTheScreen();
    expect(screen.getByText('Their post 1')).toBeOnTheScreen();
  });

  test('a failing next page keeps the posts and offers retry', async () => {
    const posts = Array.from({ length: 30 }, (_, i) => theirs(i + 1));
    const { user, failRpcOnce } = await openFeed({ content: { [C]: { posts } } });
    failRpcOnce('list_community_posts');
    await loadMore(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/);
    expect(screen.getByText('Their post 1')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("You're all caught up.")).toBeOnTheScreen();
  });
});

describe('create post', () => {
  test('posts to the current community; the author comes from the session, not the app', async () => {
    const { user, queries } = await openFeed();
    await user.press(screen.getByRole('button', { name: 'New post' }));
    await screen.findByTestId('post-editor-screen');
    expect(screen.getByText('Posting in St. Mark Choir')).toBeOnTheScreen();
    await user.type(screen.getByLabelText('What would you like to share?'), 'Choir practice is fun');
    await user.press(screen.getByRole('button', { name: 'Post' }));

    await screen.findByTestId('feed-screen');
    expect(await screen.findByText('Choir practice is fun')).toBeOnTheScreen();
    expect(within(cardOf('Choir practice is fun')).getByText('Ada L.')).toBeOnTheScreen();
    const insert = queries.find((q) => q.table === 'posts' && q.op === 'insert');
    expect(insert?.values).toEqual({ community_id: C, body: 'Choir practice is fun' });
  });

  test('validation: an empty post is not sent', async () => {
    const { user, queries } = await openFeed();
    await user.press(screen.getByRole('button', { name: 'New post' }));
    await user.press(await screen.findByRole('button', { name: 'Post' }));
    expect(screen.getByText('Write something first.')).toBeOnTheScreen();
    expect(queries.some((q) => q.op === 'insert')).toBe(false);
  });

  test('without posts.create there is no way to post', async () => {
    await openFeed({ permissions: { [C]: ['posts.view'] }, content: {} });
    expect(screen.queryByRole('button', { name: 'New post' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Write the first post' })).not.toBeOnTheScreen();
    expect(screen.getByText('Posts from members will appear here.')).toBeOnTheScreen();
  });

  test('if the server refuses (permission revoked meanwhile), nothing is posted', async () => {
    const permissions = { [C]: ['posts.view', 'posts.create'] };
    const { user, content } = await openFeed({ permissions });
    await user.press(screen.getByRole('button', { name: 'New post' }));
    await user.type(await screen.findByLabelText('What would you like to share?'), 'Sneaky');
    permissions[C] = ['posts.view'];
    await user.press(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByTestId('post-editor-error')).toHaveTextContent(/can't post in this community/);
    expect(content[C]!.posts!.some((p) => p.body === 'Sneaky')).toBe(false);
  });
});

describe('edit own post', () => {
  test('the editor loads the post from the server; saving updates only the body', async () => {
    const { user, queries } = await openFeed();
    await openMenu(user, 'My post 1');
    await user.press(within(cardOf('My post 1')).getByRole('button', { name: 'Edit post' }));
    const field = await screen.findByLabelText('Your post');
    expect(field).toHaveDisplayValue('My post 1');
    await user.clear(field);
    await user.type(field, 'My post, edited');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('My post, edited')).toBeOnTheScreen();
    expect(within(cardOf('My post, edited')).getByText(/· Edited/)).toBeOnTheScreen();
    const update = queries.find((q) => q.table === 'posts' && q.op === 'update');
    expect(update?.values).toEqual({ body: 'My post, edited' });
    expect(update?.filters).toEqual([['id', mine(1).id]]);
  });
});

describe('unauthorized edit', () => {
  test("no edit or delete on other people's posts", async () => {
    const { user } = await openFeed();
    const card = cardOf('Their post 2');
    // No menu at all on someone else's post for a plain member.
    expect(within(card).queryByRole('button', { name: 'Post options' })).not.toBeOnTheScreen();
    expect(within(card).queryByRole('button', { name: 'Edit post' })).not.toBeOnTheScreen();
    expect(within(card).queryByRole('button', { name: 'Delete post' })).not.toBeOnTheScreen();
    await openMenu(user, 'My post 1');
    expect(within(cardOf('My post 1')).getByRole('button', { name: 'Edit post' })).toBeOnTheScreen();
  });

  test('without posts.edit_own, own posts cannot be edited either', async () => {
    const { user } = await openFeed({
      permissions: { [C]: ['posts.view', 'posts.create', 'posts.delete_own'] },
    });
    await openMenu(user, 'My post 1');
    expect(within(cardOf('My post 1')).queryByRole('button', { name: 'Edit post' })).not.toBeOnTheScreen();
    expect(within(cardOf('My post 1')).getByRole('button', { name: 'Delete post' })).toBeOnTheScreen();
  });

  test('the server has the last word: a post hidden meanwhile cannot be edited', async () => {
    const { user, content } = await openFeed();
    await openMenu(user, 'My post 1');
    await user.press(within(cardOf('My post 1')).getByRole('button', { name: 'Edit post' }));
    const field = await screen.findByLabelText('Your post');
    // A moderator hides the post while the author is editing.
    content[C]!.posts!.find((p) => p.body === 'My post 1')!.status = 'hidden';
    await user.clear(field);
    await user.type(field, 'Rewritten');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('post-editor-error')).toHaveTextContent(/You can't edit this post\./);
    expect(content[C]!.posts!.some((p) => p.body === 'Rewritten')).toBe(false);
  });
});

describe('delete', () => {
  test('asks first, then soft-deletes through the server and removes the post', async () => {
    const { user, queries } = await openFeed();
    await openMenu(user, 'My post 1');
    await user.press(within(cardOf('My post 1')).getByRole('button', { name: 'Delete post' }));
    await user.press(screen.getByRole('button', { name: 'Keep it' }));
    expect(post('My post 1')).toBeOnTheScreen();

    await user.press(within(cardOf('My post 1')).getByRole('button', { name: 'Delete post' }));
    await user.press(screen.getByRole('button', { name: 'Delete post' }));
    await waitFor(() => expect(screen.queryByText('My post 1')).not.toBeOnTheScreen());
    const update = queries.find((q) => q.table === 'posts' && q.op === 'update');
    expect(update?.values).toEqual({ status: 'deleted' });
  });

  test('a refused delete keeps the post and says why', async () => {
    const permissions = { [C]: ['posts.view', 'posts.create', 'posts.edit_own', 'posts.delete_own'] };
    const { user } = await openFeed({ permissions });
    permissions[C] = ['posts.view'];
    await openMenu(user, 'My post 1');
    await user.press(within(cardOf('My post 1')).getByRole('button', { name: 'Delete post' }));
    await user.press(screen.getByRole('button', { name: 'Delete post' }));
    expect(await within(cardOf('My post 1')).findByRole('alert')).toBeOnTheScreen();
    expect(post('My post 1')).toBeOnTheScreen();
  });
});

describe('moderation state', () => {
  test('the feed shows published posts only: no Hidden or Deleted view for anyone (RN-16)', async () => {
    const view = await openFeed({
      content: {
        [C]: {
          posts: [
            mine(1, { status: 'hidden', moderation_reason: 'Off topic' }),
            theirs(2, { status: 'hidden', moderation_reason: 'Spam' }),
            theirs(3),
          ],
        },
      },
    });
    expect(screen.getByText('Their post 3')).toBeOnTheScreen();
    expect(screen.queryByText('My post 1')).not.toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Hidden' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Deleted' })).not.toBeOnTheScreen();
    // The database still returns a member's own hidden post to them, never anyone else's.
    const hidden = await view.dependencies.services.posts.list({ communityId: C, status: 'hidden' });
    expect(hidden.items.map((p) => p.body)).toEqual(['My post 1']);
  });

  test('moderators review hidden and deleted posts in the admin tools', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple],
      content: {
        [M]: {
          posts: [
            makePost(M, 1, { status: 'hidden', moderation_reason: 'Spam', body: 'Hidden one' }),
            makePost(M, 2, { status: 'deleted', body: 'Deleted one' }),
          ],
        },
      },
    });
    await screen.findByTestId('feed-screen');
    expect(screen.queryByText('Hidden one')).not.toBeOnTheScreen();
    await openHub();
    await user.press(await screen.findByRole('button', { name: 'Admin tools' }));
    await user.press(await screen.findByRole('button', { name: 'Hidden and deleted posts' }));
    expect(await screen.findByText('Hidden by a moderator: Spam')).toBeOnTheScreen();
    await user.press(screen.getByRole('tab', { name: 'Deleted' }));
    expect(await screen.findByText('Deleted one')).toBeOnTheScreen();
  });
});

describe('community isolation', () => {
  test("only the current community's posts, even if the server sent another's", async () => {
    const { rpc } = await openFeed({
      content: { [C]: { posts: [theirs(1), makePost(M, 9, { body: 'Maple secret' })] } },
    });
    expect(screen.getByText('Their post 1')).toBeOnTheScreen();
    expect(screen.queryByText('Maple secret')).not.toBeOnTheScreen();
    expect(listCalls(rpc).every((c) => c.p_community_id === C)).toBe(true);
  });

  test('switching community shows the other feed only', async () => {
    const user = userEvent.setup();
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { [M]: { posts: [makePost(M, 1, { body: 'Maple news' })] }, [C]: { posts: [theirs(1)] } },
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    expect(await screen.findByText('Their post 1')).toBeOnTheScreen();

    // The feed header names the community and switches it.
    await user.press(screen.getByTestId('feed-community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    expect(await screen.findByText('Maple news')).toBeOnTheScreen();
    expect(screen.getByLabelText('Switch community. Current community: Maple Grove HOA')).toBeOnTheScreen();
    expect(screen.queryByText('Their post 1')).not.toBeOnTheScreen();
    const last = listCalls(fake.rpc).at(-1)!;
    expect(last.p_community_id).toBe(M);
  });
});

describe('refresh', () => {
  test('pull to refresh shows new posts', async () => {
    const { content } = await openFeed();
    content[C]!.posts = [
      theirs(0, { body: 'Brand new', created_at: '2026-10-13T09:00:00Z' }),
      ...content[C]!.posts!,
    ];
    await pullToRefresh();
    expect(await screen.findByText('Brand new')).toBeOnTheScreen();
  });

  test('a failed refresh keeps the posts and reports the problem', async () => {
    const { setOffline } = await openFeed();
    setOffline(true);
    await pullToRefresh();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't reach CommuniOne/i);
    expect(screen.getByText('My post 1')).toBeOnTheScreen();
  });
});

describe('reactions', () => {
  test('like and remove, confirmed by the server', async () => {
    const { user } = await openFeed({ content: { [C]: { posts: [theirs(1, { reaction_count: 1 })] } } });
    const card = () => cardOf('Their post 1');
    expect(await within(card()).findByLabelText('1 Like')).toBeOnTheScreen();
    await user.press(within(card()).getByRole('button', { name: 'React with Like' }));
    expect(await within(card()).findByLabelText('2 Like')).toBeOnTheScreen();
    await user.press(within(card()).getByRole('button', { name: 'Remove your Like reaction' }));
    expect(await within(card()).findByLabelText('1 Like')).toBeOnTheScreen();
  });
});

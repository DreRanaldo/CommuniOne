// Comments, replies, reactions and moderation through the whole app (REAL
// service layer) against a fake Supabase applying the database rules:
// comment visibility (published / hidden / deleted), can_comment_on(), own
// edits and deletes, one reaction per user and target (unique index),
// can_react_to(), and the moderation permissions.
import { act, fireEvent, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeComment,
  makePost,
  makeSession,
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
const C = choir.community_id; // the user is a Member here
const M = maple.community_id; // the user is the Owner (moderator) here

const post = makePost(C, 1, { body: 'Choir trip', comment_count: 2 });
const theirComment = makeComment(C, post.id, 1, { body: 'Count me in', reply_count: 1, reaction_count: 1 });
const reply = makeComment(C, post.id, 2, { body: 'Me too', parent_comment_id: theirComment.id, depth: 1 });
const myComment = makeComment(C, post.id, 3, {
  body: 'I will bring snacks',
  author_user_id: TEST_USER_ID,
  author_display_name: 'Ada L.',
});

const choirContent = () => ({
  [C]: { posts: [{ ...post }], comments: [{ ...theirComment }, { ...reply }, { ...myComment }] },
});

/** Signed in (choir only), feed open, then the post with its comments. */
async function openPost(options: FakeOptions = {}, body = 'Choir trip') {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    content: choirContent(),
    ...options,
  });
  await screen.findByTestId('community-home-screen');
  await user.press(screen.getByRole('button', { name: 'Feed' }));
  await screen.findByText(body);
  await user.press(screen.getByRole('button', { name: /comments?\. Open comments$/ }));
  await screen.findByTestId('post-detail-screen');
  await screen.findByTestId('comments');
  return { user, ...app };
}

const commentCard = (id: string) => screen.getByTestId(`comment-${id}`);
const inserts = (queries: { table: string; op: string; values?: unknown }[], table: string) =>
  queries.filter((q) => q.table === table && q.op === 'insert').map((q) => q.values);

describe('comments', () => {
  test('a post opens with its comments, oldest first; replies on demand', async () => {
    const { user } = await openPost();
    const thread = screen.getByTestId('comments');
    const bodies = within(thread)
      .getAllByText(/^(Count me in|I will bring snacks)$/)
      .map((n) => n.props.children);
    expect(bodies).toEqual(['Count me in', 'I will bring snacks']);
    expect(screen.queryByText('Me too')).not.toBeOnTheScreen();
    await user.press(within(commentCard(theirComment.id)).getByRole('button', { name: 'View 1 reply' }));
    expect(await screen.findByText('Me too')).toBeOnTheScreen();
  });

  test('pagination: 20 at a time, then "Load more comments"', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeComment(C, post.id, 100 + i, { body: `Note ${i + 1}` }),
    );
    const { user, rpc } = await openPost({ content: { [C]: { posts: [{ ...post }], comments: many } } });
    expect(screen.getByText('Note 20')).toBeOnTheScreen();
    expect(screen.queryByText('Note 21')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Load more comments' }));
    expect(await screen.findByText('Note 25')).toBeOnTheScreen();
    const calls = rpc.mock.calls
      .filter(([n]) => n === 'list_post_comments')
      .map(([, a]) => a as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ p_post_id: post.id, p_limit: 20 });
    expect(calls.at(-1)!.p_cursor_created_at).toBe(many[19]!.created_at);
    expect(screen.queryByRole('button', { name: 'Load more comments' })).not.toBeOnTheScreen();
  });

  test("create: appears once the server accepts it; the post's count follows", async () => {
    const { user, queries } = await openPost();
    await user.type(screen.getByLabelText('Write a comment'), 'See you there');
    await user.press(within(screen.getByTestId('comment-composer')).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('See you there')).toBeOnTheScreen();
    expect(within(commentCard('f6f6f6f6-0000-4000-8000-000000000101')).getByText('Ada L.')).toBeOnTheScreen();
    expect(screen.getByLabelText('3 comments')).toBeOnTheScreen();
    expect(inserts(queries, 'comments')).toEqual([
      { post_id: post.id, parent_comment_id: null, body: 'See you there' },
    ]);
    expect(screen.getByLabelText('Write a comment')).toHaveDisplayValue('');
  });

  test('a double tap posts once', async () => {
    const { user, queries } = await openPost();
    await user.type(screen.getByLabelText('Write a comment'), 'Only once');
    const send = within(screen.getByTestId('comment-composer')).getByRole('button', { name: 'Send' });
    await act(async () => {
      void fireEvent.press(send);
      void fireEvent.press(send);
    });
    await screen.findByText('Only once');
    expect(inserts(queries, 'comments')).toHaveLength(1);
  });

  test('validation: empty comments are not sent', async () => {
    const { user, queries } = await openPost();
    await user.press(within(screen.getByTestId('comment-composer')).getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Write something first.')).toBeOnTheScreen();
    expect(inserts(queries, 'comments')).toEqual([]);
  });
});

describe('replies', () => {
  test('replying shows the reply in the thread', async () => {
    const { user, queries } = await openPost();
    await user.press(within(commentCard(theirComment.id)).getByRole('button', { name: 'Reply to Grace H.' }));
    await user.type(screen.getByLabelText('Reply to Grace H.'), 'Great idea');
    await user.press(
      within(screen.getByTestId(`reply-to-${theirComment.id}`)).getByRole('button', { name: 'Reply' }),
    );
    const replies = await screen.findByTestId(`replies-${theirComment.id}`);
    expect(await within(replies).findByText('Great idea')).toBeOnTheScreen();
    expect(within(replies).getByText('Me too')).toBeOnTheScreen();
    expect(inserts(queries, 'comments')).toEqual([
      { post_id: post.id, parent_comment_id: theirComment.id, body: 'Great idea' },
    ]);
  });

  test('a reply to a comment hidden meanwhile is refused by the server', async () => {
    const { user, content } = await openPost();
    await user.press(within(commentCard(theirComment.id)).getByRole('button', { name: 'Reply to Grace H.' }));
    await user.type(screen.getByLabelText('Reply to Grace H.'), 'Too late');
    content[C]!.comments!.find((c) => c.id === theirComment.id)!.status = 'hidden';
    await user.press(
      within(screen.getByTestId(`reply-to-${theirComment.id}`)).getByRole('button', { name: 'Reply' }),
    );
    expect(await screen.findByText(/Parent comment not found/i)).toBeOnTheScreen();
    expect(content[C]!.comments!.some((c) => c.body === 'Too late')).toBe(false);
  });
});

describe('reactions', () => {
  test('every supported type can be chosen; counts per type follow', async () => {
    const { user } = await openPost();
    const card = () => commentCard(theirComment.id);
    expect(await within(card()).findByLabelText('1 Like')).toBeOnTheScreen();
    await user.press(within(card()).getByRole('button', { name: 'Choose a reaction' }));
    const options = within(card())
      .getAllByRole('radio')
      .map((n) => n.props.accessibilityLabel as string);
    expect(options).toEqual([
      'React with Like',
      'React with Love',
      'React with Celebrate',
      'React with Support',
      'React with Laugh',
      'React with Sad',
    ]);
    await user.press(within(card()).getByRole('radio', { name: 'React with Love' }));
    expect(await within(card()).findByLabelText('1 Love')).toBeOnTheScreen();
    expect(within(card()).getByRole('button', { name: 'Remove your Love reaction' })).toBeOnTheScreen();
    await waitFor(() => expect(within(card()).getByLabelText('1 Like')).toBeOnTheScreen());

    // Changing type keeps one reaction.
    await user.press(within(card()).getByRole('button', { name: 'Choose a reaction' }));
    await user.press(within(card()).getByRole('radio', { name: 'React with Laugh' }));
    expect(await within(card()).findByLabelText('1 Laugh')).toBeOnTheScreen();
    expect(within(card()).queryByLabelText('1 Love')).not.toBeOnTheScreen();

    await user.press(within(card()).getByRole('button', { name: 'Remove your Laugh reaction' }));
    await waitFor(() => expect(within(card()).queryByLabelText('1 Laugh')).not.toBeOnTheScreen());
  });

  test('reacting to the post itself', async () => {
    const { user } = await openPost();
    const card = screen.getByTestId(`post-${post.id}`);
    await user.press(within(card).getByRole('button', { name: 'React with Like' }));
    expect(await within(card).findByLabelText(/^\d+ Like$/)).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'Remove your Like reaction' })).toBeOnTheScreen();
  });
});

describe('duplicate reactions', () => {
  test('rapid taps send one request at a time and end consistent with the server', async () => {
    const { from, queries } = await openPost();
    // Hold every reaction write until released, and count how many run at once.
    let release: () => void = () => {};
    let gate = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const real = from.getMockImplementation()!;
    from.mockImplementation((table: string) => {
      const builder = real(table);
      if (table !== 'reactions') return builder;
      const then = builder.then.bind(builder);
      builder.then = ((resolve, reject) => {
        calls += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return gate.then(() =>
          then(
            (value) => {
              running -= 1;
              return resolve!(value);
            },
            (error) => {
              running -= 1;
              return reject ? reject(error) : Promise.reject(error);
            },
          ),
        );
      }) as typeof builder.then;
      return builder;
    });

    const card = () => commentCard(myComment.id);
    const press = (name: string) => fireEvent.press(within(card()).getByRole('button', { name }));
    // like, unlike, like again: three quick taps.
    await act(async () => {
      void press('React with Like');
    });
    await act(async () => {
      void press('Remove your Like reaction');
    });
    await act(async () => {
      void press('React with Like');
    });
    // Optimistic: shows the latest choice.
    expect(within(card()).getByRole('button', { name: 'Remove your Like reaction' })).toBeOnTheScreen();

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        release();
        gate = new Promise<void>((resolve) => (release = resolve));
      });
    }
    await waitFor(() => expect(running).toBe(0));
    expect(maxRunning).toBe(1);
    // The three taps collapse: only the final intent (like) is sent, as one read and one write.
    expect(calls).toBeLessThanOrEqual(4);
    const reactionWrites = queries.filter((q) => q.table === 'reactions' && q.op !== 'select');
    expect(reactionWrites.map((q) => q.op)).toEqual(['insert']);
    expect(within(card()).getByLabelText('1 Like')).toBeOnTheScreen();
  });

  test('a failed reaction reverts the optimistic change and says why', async () => {
    const { user, setOffline } = await openPost();
    const card = () => commentCard(myComment.id);
    setOffline(true);
    await user.press(within(card()).getByRole('button', { name: 'React with Like' }));
    expect(await within(card()).findByRole('alert')).toHaveTextContent(/couldn't reach CommuniOne/i);
    expect(within(card()).getByRole('button', { name: 'React with Like' })).toBeOnTheScreen();
    expect(within(card()).queryByLabelText('1 Like')).not.toBeOnTheScreen();
  });

  test('a rejected reaction reverts, explains, and refreshes', async () => {
    const { user, content } = await openPost();
    const card = () => commentCard(theirComment.id);
    await within(card()).findByLabelText('1 Like');
    // A moderator hides the comment before the user reacts.
    content[C]!.comments!.find((c) => c.id === theirComment.id)!.status = 'hidden';
    await user.press(within(card()).getByRole('button', { name: 'React with Like' }));
    // Refreshed: the hidden comment is gone for this member.
    await waitFor(() => expect(screen.queryByText('Count me in')).not.toBeOnTheScreen());
    expect(screen.getByText('I will bring snacks')).toBeOnTheScreen();
  });
});

describe('own-content editing', () => {
  test('edit and delete only on your own comments', async () => {
    await openPost();
    expect(within(commentCard(myComment.id)).getByRole('button', { name: 'Edit comment' })).toBeOnTheScreen();
    expect(
      within(commentCard(myComment.id)).getByRole('button', { name: 'Delete comment' }),
    ).toBeOnTheScreen();
    expect(
      within(commentCard(theirComment.id)).queryByRole('button', { name: 'Edit comment' }),
    ).not.toBeOnTheScreen();
    expect(
      within(commentCard(theirComment.id)).queryByRole('button', { name: 'Delete comment' }),
    ).not.toBeOnTheScreen();
  });

  test('editing updates the comment once the server accepts it', async () => {
    const { user, queries } = await openPost();
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Edit comment' }));
    const field = screen.getByLabelText('Edit your comment');
    expect(field).toHaveDisplayValue('I will bring snacks');
    await user.clear(field);
    await user.type(field, 'I will bring drinks');
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('I will bring drinks')).toBeOnTheScreen();
    expect(within(commentCard(myComment.id)).getByText(/· Edited/)).toBeOnTheScreen();
    const update = queries.find((q) => q.table === 'comments' && q.op === 'update');
    expect(update).toMatchObject({
      values: { body: 'I will bring drinks' },
      filters: [['id', myComment.id]],
    });
  });

  test('a refused edit shows the error and changes nothing', async () => {
    const { user, content } = await openPost();
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Edit comment' }));
    await user.type(screen.getByLabelText('Edit your comment'), '!');
    content[C]!.comments!.find((c) => c.id === myComment.id)!.status = 'hidden';
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Save' }));
    expect(await within(commentCard(myComment.id)).findByText(/permission/i)).toBeOnTheScreen();
    expect(content[C]!.comments!.find((c) => c.id === myComment.id)!.body).toBe('I will bring snacks');
  });

  test("delete asks first; the post's count follows", async () => {
    const { user } = await openPost();
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Delete comment' }));
    await user.press(screen.getByRole('button', { name: 'Keep it' }));
    await user.press(within(commentCard(myComment.id)).getByRole('button', { name: 'Delete comment' }));
    await user.press(screen.getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(screen.queryByText('I will bring snacks')).not.toBeOnTheScreen());
    expect(screen.getByLabelText('1 comment')).toBeOnTheScreen();
  });

  test('deleting a comment with replies keeps a placeholder so the replies stay reachable', async () => {
    const mine = makeComment(C, post.id, 4, {
      body: 'Mine with replies',
      author_user_id: TEST_USER_ID,
      reply_count: 1,
    });
    const answer = makeComment(C, post.id, 5, { body: 'An answer', parent_comment_id: mine.id, depth: 1 });
    const { user } = await openPost({ content: { [C]: { posts: [{ ...post }], comments: [mine, answer] } } });
    await user.press(within(commentCard(mine.id)).getByRole('button', { name: 'Delete comment' }));
    await user.press(screen.getAllByRole('button', { name: 'Delete comment' }).at(-1)!);
    expect(await within(commentCard(mine.id)).findByText('Comment deleted')).toBeOnTheScreen();
    await user.press(within(commentCard(mine.id)).getByRole('button', { name: 'View 1 reply' }));
    expect(await screen.findByText('An answer')).toBeOnTheScreen();
  });
});

describe('moderation and permissions', () => {
  test('members see no moderation actions', async () => {
    await openPost();
    expect(screen.queryByRole('button', { name: 'Hide post' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Hide comment' })).not.toBeOnTheScreen();
  });

  test('without comments.create: no composer and no reply buttons', async () => {
    await openPost({ permissions: { [C]: ['posts.view'] } });
    expect(screen.queryByTestId('comment-composer')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Reply to/ })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeOnTheScreen();
  });

  async function asModerator(user: User) {
    await screen.findByTestId('community-home-screen');
    await user.press(screen.getByRole('button', { name: 'Feed' }));
  }

  test('moderators hide a post with a reason, then restore it', async () => {
    const user = userEvent.setup();
    const mPost = makePost(M, 1, { body: 'Buy my stuff', author_user_id: OTHER_USER_ID });
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple],
      content: { [M]: { posts: [mPost] } },
    });
    await asModerator(user);
    await user.press(await screen.findByRole('button', { name: 'Hide post' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Spam');
    await user.press(screen.getAllByRole('button', { name: 'Hide post' }).at(-1)!);
    await waitFor(() => expect(screen.queryByText('Buy my stuff')).not.toBeOnTheScreen());
    expect(fake.content[M]!.posts![0]).toMatchObject({ status: 'hidden', moderation_reason: 'Spam' });

    await user.press(screen.getByRole('tab', { name: 'Hidden' }));
    expect(await screen.findByText('Hidden by a moderator: Spam')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Restore post' }));
    await waitFor(() => expect(fake.content[M]!.posts![0]!.status).toBe('published'));
  });

  test('moderators hide and restore comments', async () => {
    const user = userEvent.setup();
    const mPost = makePost(M, 1, { body: 'Agenda', comment_count: 1 });
    const rude = makeComment(M, mPost.id, 1, { body: 'Rude remark' });
    const fake = await renderApp({
      session: makeSession(),
      communities: [maple],
      content: { [M]: { posts: [mPost], comments: [rude] } },
    });
    await asModerator(user);
    await user.press(await screen.findByRole('button', { name: '1 comment. Open comments' }));
    await user.press(await screen.findByRole('button', { name: 'Hide comment' }));
    await user.press(screen.getAllByRole('button', { name: 'Hide comment' }).at(-1)!);
    expect(await within(commentCard(rude.id)).findByText('Hidden by a moderator')).toBeOnTheScreen();
    expect(fake.content[M]!.comments![0]!.status).toBe('hidden');
    await user.press(within(commentCard(rude.id)).getByRole('button', { name: 'Restore comment' }));
    await waitFor(() => expect(fake.content[M]!.comments![0]!.status).toBe('published'));
  });

  test("a member never receives other people's hidden comments", async () => {
    const hidden = makeComment(C, post.id, 6, { body: 'Hidden remark', status: 'hidden' });
    const ownHidden = makeComment(C, post.id, 7, {
      body: 'My hidden remark',
      status: 'hidden',
      author_user_id: TEST_USER_ID,
    });
    await openPost({ content: { [C]: { posts: [{ ...post }], comments: [hidden, ownHidden] } } });
    expect(screen.queryByText('Hidden remark')).not.toBeOnTheScreen();
    expect(within(commentCard(ownHidden.id)).getByText('Hidden by a moderator')).toBeOnTheScreen();
  });
});

describe('cross-community protection', () => {
  test("switching community closes the other community's post and thread", async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: { ...choirContent(), [M]: { posts: [makePost(M, 9, { body: 'Maple only' })] } },
    });
    await user.press(await screen.findByTestId(`community-card-${C}`));
    await user.press(await screen.findByRole('button', { name: 'Feed' }));
    await user.press(await screen.findByRole('button', { name: /comments?\. Open comments$/ }));
    await screen.findByText('Count me in');

    await user.press(screen.getByRole('button', { name: /^Home/ }));
    await user.press(await screen.findByTestId('community-switcher'));
    await user.press(await screen.findByTestId(`community-card-${M}`));
    await screen.findByLabelText('Switch community. Current community: Maple Grove HOA');
    expect(screen.queryByText('Count me in')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('post-detail-screen')).not.toBeOnTheScreen();
  });

  test("a post hidden after the feed loaded is not shown from the feed's copy", async () => {
    const user = userEvent.setup();
    const fake = await renderApp({ session: makeSession(), communities: [choir], content: choirContent() });
    await screen.findByTestId('community-home-screen');
    await user.press(screen.getByRole('button', { name: 'Feed' }));
    await screen.findByText('Choir trip');
    // A moderator hides it meanwhile; opening re-reads the post from the server.
    fake.content[C]!.posts![0]!.status = 'hidden';
    await user.press(screen.getByRole('button', { name: /comments?\. Open comments$/ }));
    expect(await screen.findByText('This post is not available')).toBeOnTheScreen();
    expect(screen.queryByText('Count me in')).not.toBeOnTheScreen();
  });
});

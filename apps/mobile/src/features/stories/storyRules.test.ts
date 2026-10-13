import type { Story } from '@communione/services';
import { firstName, firstUnseen, groupStories, storyAge } from './storyRules';

const story = (id: string, author: string, viewed = false, name: string | null = 'Sarah Anderson'): Story =>
  ({ id, author_user_id: author, author_display_name: name, viewed_by_me: viewed }) as Story;

test('groups keep the server order; a group is seen only when every story is', () => {
  const groups = groupStories(
    [story('1', 'me', true), story('2', 'a', true), story('3', 'a', false), story('4', 'b', true, null)],
    'me',
  );
  expect(groups.map((g) => [g.authorId, g.mine, g.allSeen, g.stories.length])).toEqual([
    ['me', true, true, 1],
    ['a', false, false, 2],
    ['b', false, true, 1],
  ]);
  expect(groups[2]!.name).toBe('Member');
});

test('the viewer starts at the first unseen story', () => {
  const [group] = groupStories([story('1', 'a', true), story('2', 'a', false)], null);
  expect(firstUnseen(group!)).toBe(1);
  const [seen] = groupStories([story('1', 'a', true)], null);
  expect(firstUnseen(seen!)).toBe(0);
});

test('labels', () => {
  expect(firstName('Sarah Anderson')).toBe('Sarah');
  const now = Date.parse('2026-10-13T12:00:00Z');
  expect(storyAge('2026-10-13T11:59:40Z', now)).toBe('now');
  expect(storyAge('2026-10-13T11:45:00Z', now)).toBe('15m');
  expect(storyAge('2026-10-13T09:00:00Z', now)).toBe('3h');
});

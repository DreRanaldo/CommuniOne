import type { ActiveAlert, CommunityEvent, CurrentAnnouncement, FeedPost } from '@communione/services';
import { mergeTimeline, NO_EXTRAS } from './timeline';

const at = (hour: number) => `2026-10-12T${String(hour).padStart(2, '0')}:00:00Z`;
const post = (id: string, hour: number) => ({ id, created_at: at(hour) }) as FeedPost;
const announcement = (id: string, hour: number) => ({ id, published_at: at(hour) }) as CurrentAnnouncement;
const event = (id: string, hour: number | null, created: number) =>
  ({ id, published_at: hour === null ? null : at(hour), created_at: at(created) }) as CommunityEvent;
const alert = (id: string, hour: number) => ({ id, published_at: at(hour) }) as ActiveAlert;

const keys = (items: { key: string }[]) => items.map((i) => i.key);

test('extras are placed among the posts by when they were published, newest first', () => {
  const items = mergeTimeline(
    [post('p1', 12), post('p2', 8)],
    { announcements: [announcement('a1', 10)], events: [event('e1', null, 13)], alerts: [alert('x1', 9)] },
    false,
  );
  expect(keys(items)).toEqual(['event-e1', 'post-p1', 'announcement-a1', 'alert-x1', 'post-p2']);
});

test('while older posts remain, extras older than the oldest loaded post wait', () => {
  const extras = { ...NO_EXTRAS, announcements: [announcement('old', 5), announcement('new', 11)] };
  expect(keys(mergeTimeline([post('p1', 12), post('p2', 10)], extras, true))).toEqual([
    'post-p1',
    'announcement-new',
    'post-p2',
  ]);
  expect(keys(mergeTimeline([post('p1', 12), post('p2', 10)], extras, false))).toContain('announcement-old');
});

test('no posts: extras alone once the feed is complete, nothing while it is still loading', () => {
  const extras = { ...NO_EXTRAS, alerts: [alert('x1', 9)] };
  expect(keys(mergeTimeline([], extras, false))).toEqual(['alert-x1']);
  expect(mergeTimeline([], extras, true)).toEqual([]);
});

test('equal times keep posts first (stable order)', () => {
  const items = mergeTimeline(
    [post('p1', 10)],
    { ...NO_EXTRAS, announcements: [announcement('a1', 10)] },
    false,
  );
  expect(keys(items)).toEqual(['post-p1', 'announcement-a1']);
});

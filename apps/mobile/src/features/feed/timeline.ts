// The feed's timeline (RN-16): posts interleaved with current announcements,
// upcoming events and active alerts, newest first. Each kind is read from its
// own list function (the database decides what the user may see); this file
// only orders what was returned.
import type { ActiveAlert, CommunityEvent, CurrentAnnouncement, FeedPost } from '@communione/services';

export type TimelineItem =
  | { kind: 'post'; key: string; at: string; post: FeedPost }
  | { kind: 'announcement'; key: string; at: string; announcement: CurrentAnnouncement }
  | { kind: 'event'; key: string; at: string; event: CommunityEvent }
  | { kind: 'alert'; key: string; at: string; alert: ActiveAlert };

export interface TimelineExtras {
  announcements: CurrentAnnouncement[];
  events: CommunityEvent[];
  alerts: ActiveAlert[];
}

export const NO_EXTRAS: TimelineExtras = { announcements: [], events: [], alerts: [] };

const time = (iso: string) => Date.parse(iso) || 0;

/**
 * Posts (already newest first) with the extras placed by when they were
 * published. While older posts remain to be loaded (`hasMore`), extras older
 * than the oldest loaded post wait, so the order never jumps when the next
 * page arrives.
 */
export function mergeTimeline(posts: FeedPost[], extras: TimelineExtras, hasMore: boolean): TimelineItem[] {
  const oldest = posts.length > 0 ? time(posts[posts.length - 1]!.created_at) : Infinity;
  const extra: TimelineItem[] = [
    ...extras.announcements.map((a) => ({
      kind: 'announcement' as const,
      key: `announcement-${a.id}`,
      at: a.published_at,
      announcement: a,
    })),
    ...extras.events.map((e) => ({
      kind: 'event' as const,
      key: `event-${e.id}`,
      at: e.published_at ?? e.created_at,
      event: e,
    })),
    ...extras.alerts.map((a) => ({
      kind: 'alert' as const,
      key: `alert-${a.id}`,
      at: a.published_at,
      alert: a,
    })),
  ].filter((item) => !hasMore || posts.length === 0 || time(item.at) >= oldest);
  // While nothing is loaded yet and more may come, show nothing extra either.
  if (hasMore && posts.length === 0) return [];
  const items: TimelineItem[] = [
    ...posts.map((p) => ({ kind: 'post' as const, key: `post-${p.id}`, at: p.created_at, post: p })),
    ...extra,
  ];
  // Stable: equal times keep posts first, then the order above.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => time(b.item.at) - time(a.item.at) || a.index - b.index)
    .map(({ item }) => item);
}

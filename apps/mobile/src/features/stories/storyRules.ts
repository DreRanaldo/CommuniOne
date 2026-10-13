// Grouping and wording for stories. The server decides which stories exist
// for the caller (active, in a community they may see) and in which order;
// this only groups them by author for the bar and the viewer.
import type { Story } from '@communione/services';

export interface StoryGroup {
  authorId: string;
  name: string;
  mine: boolean;
  /** Every story of this author has been seen by the caller. */
  allSeen: boolean;
  stories: Story[];
}

/** One group per author, in the server's order (own first, unseen first, newest first). */
export function groupStories(rows: Story[], myId: string | null): StoryGroup[] {
  const groups = new Map<string, StoryGroup>();
  for (const row of rows) {
    const group = groups.get(row.author_user_id) ?? {
      authorId: row.author_user_id,
      name: row.author_display_name?.trim() || 'Member',
      mine: row.author_user_id === myId,
      allSeen: true,
      stories: [],
    };
    group.stories.push(row);
    group.allSeen = group.allSeen && row.viewed_by_me;
    groups.set(row.author_user_id, group);
  }
  return [...groups.values()];
}

/** The first story to show: the first one not seen yet, else the first. */
export const firstUnseen = (group: StoryGroup) =>
  Math.max(
    0,
    group.stories.findIndex((s) => !s.viewed_by_me),
  );

/** "Sarah" from "Sarah Anderson" (bubble labels are short). */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** How long ago, compactly: "now", "5m", "3h". */
export function storyAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

import type { Story } from '@communione/services';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthProvider';
import { useServices } from '@/lib/dependencies';
import { groupStories, type StoryGroup } from './storyRules';

/**
 * The community's active stories, grouped by author. Never blocks the feed:
 * a failed load keeps what was shown (or shows no stories). Reloading keeps
 * the current bar until the new answer arrives.
 */
export function useStories(communityId: string) {
  const { stories, posts } = useServices();
  const { session } = useAuth();
  const myId = session?.user.id ?? null;
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    stories.list(communityId).then(
      async (rows: Story[]) => {
        if (!current) return;
        const next = groupStories(rows, myId);
        setGroups(next);
        // Profile pictures of the authors (co-members only; best effort).
        const ids = next.map((g) => g.authorId).slice(0, 100);
        if (ids.length === 0) return;
        const urls = await posts.authorAvatars(ids).catch(() => ({}));
        if (current) setAvatars(urls);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [stories, posts, communityId, myId, attempt]);

  return { groups, avatars, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

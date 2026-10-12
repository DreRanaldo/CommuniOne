import { createContext, useContext } from 'react';

/** What every comment of one post needs, loaded once for the whole thread. */
export interface ThreadContextValue {
  postId: string;
  /** New comments and reactions need a published post (the database checks it too). */
  postPublished: boolean;
  /** The signed-in user (to recognise their own comments; display only). */
  viewerId: string | null;
  /** The user's permissions in the community (display only; the database re-checks). */
  can(permission: string): boolean;
  /** A comment was added or removed somewhere in the thread (for the post's count). */
  onCountChange(delta: number): void;
}

export const ThreadContext = createContext<ThreadContextValue | null>(null);

export function useThread(): ThreadContextValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error('useThread must be used inside a ThreadContext');
  return value;
}

/** Comments nest at most 10 levels (depth 0–9, database CHECK). */
export const MAX_COMMENT_DEPTH = 9;

import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/lib/dependencies';
import { errorMessage, isNetworkError } from '@/utils/errors';
import { applyReaction, type ReactionState, type ReactionType } from './reactions';

export type ReactionTarget =
  { postId: string; commentId?: undefined } | { commentId: string; postId?: undefined };

/**
 * The user's reaction to one post or comment, with an optimistic display.
 *
 * - Optimistic: reacting is low-risk and reversible, so the change shows at
 *   once and the request runs in the background.
 * - One request at a time per target: further taps while a request runs only
 *   record the latest choice, which is sent when the request returns. Rapid
 *   taps therefore cannot race each other (and the server keeps one reaction
 *   per user anyway).
 * - Rejected (e.g. the post was hidden, or the network failed): the display
 *   reverts to the last confirmed state and an error is shown; when the
 *   server refused, `onRejected` lets the screen refresh the affected data.
 */
export function useReaction(
  target: ReactionTarget,
  initial: ReactionState,
  onRejected?: (error: unknown) => void,
) {
  const { posts } = useServices();
  // Adopt new server data (e.g. after a refresh) unless a change is pending.
  const [source, setSource] = useState(initial);
  const [confirmed, setConfirmed] = useState(initial);
  const [desired, setDesired] = useState<ReactionType | null>(initial.mine);
  const confirmedRef = useRef(initial);
  const desiredRef = useRef<ReactionType | null>(initial.mine);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (
    (source.mine !== initial.mine || source.total !== initial.total || source.counts !== initial.counts) &&
    desired === confirmed.mine
  ) {
    setSource(initial);
    setConfirmed(initial);
    setDesired(initial.mine);
  }

  // Keep the request loop's view in step with adopted server data.
  useEffect(() => {
    if (inFlight.current) return;
    confirmedRef.current = source;
    desiredRef.current = source.mine;
  }, [source]);

  const send = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (desiredRef.current !== confirmedRef.current.mine) {
        const next = desiredRef.current;
        try {
          if (next) await posts.react({ ...target, type: next });
          else await posts.unreact(target);
          confirmedRef.current = applyReaction(confirmedRef.current, next);
          setConfirmed(confirmedRef.current);
        } catch (thrown) {
          desiredRef.current = confirmedRef.current.mine;
          setDesired(confirmedRef.current.mine);
          setError(errorMessage(thrown));
          // The server refused (e.g. the content was hidden): show its current state.
          // A network failure changes nothing on the server, so there is nothing to refresh.
          if (!isNetworkError(thrown)) onRejected?.(thrown);
          return;
        }
      }
    } finally {
      inFlight.current = false;
    }
    // A target object is created per render; its ids are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, target.postId, target.commentId, onRejected]);

  const choose = useCallback(
    (next: ReactionType | null) => {
      setError(null);
      desiredRef.current = next;
      setDesired(next);
      void send();
    },
    [send],
  );

  const display = applyReaction(confirmed, desired);
  return {
    display,
    /** Tap: react with `type` (default like), or remove the current reaction. */
    toggle: (type: ReactionType = 'like') => choose(display.mine ? null : type),
    choose,
    pending: desired !== confirmed.mine,
    error,
  };
}

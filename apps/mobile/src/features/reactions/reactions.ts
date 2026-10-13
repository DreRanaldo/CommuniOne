// Reaction types and the arithmetic of changing one's reaction. The database
// allows one reaction per user and post/comment (unique index); these
// helpers apply the same rule to what the app displays.
import type { IconName } from '@/components';

export const REACTIONS = [
  { type: 'like', label: 'Like', icon: 'heart' },
  { type: 'love', label: 'Love', icon: 'heart' },
  { type: 'celebrate', label: 'Celebrate', icon: 'sparkles' },
  { type: 'support', label: 'Support', icon: 'hand-left' },
  { type: 'laugh', label: 'Laugh', icon: 'happy' },
  { type: 'sad', label: 'Sad', icon: 'sad' },
] as const satisfies readonly { type: string; label: string; icon: IconName }[];

export type ReactionType = (typeof REACTIONS)[number]['type'];
export const reactionInfo = (type: string) => REACTIONS.find((r) => r.type === type);
export const isReactionType = (value: unknown): value is ReactionType =>
  typeof value === 'string' && REACTIONS.some((r) => r.type === value);

export interface ReactionState {
  /** The user's own reaction. */
  mine: ReactionType | null;
  /** Everyone's reactions. */
  total: number;
  /** Per type, when known (reaction summary); null otherwise. */
  counts: Partial<Record<ReactionType, number>> | null;
}

/** The state after the user's reaction becomes `next` (one reaction per user). */
export function applyReaction(state: ReactionState, next: ReactionType | null): ReactionState {
  if (state.mine === next) return state;
  const counts = state.counts ? { ...state.counts } : null;
  if (counts && state.mine) counts[state.mine] = Math.max(0, (counts[state.mine] ?? 1) - 1);
  if (counts && next) counts[next] = (counts[next] ?? 0) + 1;
  const total = Math.max(0, state.total + (next ? 1 : 0) - (state.mine ? 1 : 0));
  return { mine: next, total, counts };
}

/** Builds per-target counts from get_reaction_summary() rows. */
export function countsFromSummary(
  rows: {
    post_id: string | null;
    comment_id: string | null;
    reaction_type: string;
    reaction_count: number;
  }[],
  key: 'post_id' | 'comment_id',
): Record<string, Partial<Record<ReactionType, number>>> {
  const result: Record<string, Partial<Record<ReactionType, number>>> = {};
  for (const row of rows) {
    const id = row[key];
    if (!id || !isReactionType(row.reaction_type)) continue;
    (result[id] ??= {})[row.reaction_type] = Number(row.reaction_count);
  }
  return result;
}

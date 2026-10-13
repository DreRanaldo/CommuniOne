import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { REACTIONS, reactionInfo, type ReactionState } from './reactions';
import { useReaction, type ReactionTarget } from './useReaction';

export interface ReactionBarProps {
  target: ReactionTarget;
  initial: ReactionState;
  /** False for hidden or deleted content (no new reactions). */
  enabled: boolean;
  /** The server refused a change: refresh the affected data. */
  onRejected?: (error: unknown) => void;
}

/**
 * React to a post or comment: tap to like (or remove your reaction), or pick
 * any supported type; per-type counts when known, otherwise the total.
 */
export function ReactionBar({ target, initial, enabled, onRejected }: ReactionBarProps) {
  const styles = useStyles();
  const reaction = useReaction(target, initial, onRejected);
  const [picking, setPicking] = useState(false);
  const { mine, total, counts } = reaction.display;
  const mineInfo = mine ? reactionInfo(mine) : undefined;
  const shown = counts ? REACTIONS.filter((r) => (counts[r.type] ?? 0) > 0) : [];

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mineInfo ? `Remove your ${mineInfo.label} reaction` : 'React with Like'}
          accessibilityState={{ selected: !!mine, disabled: !enabled }}
          disabled={!enabled}
          onPress={() => reaction.toggle('like')}
          style={[styles.button, mine && styles.selected]}
          hitSlop={6}
        >
          <Icon
            name={mineInfo ? mineInfo.icon : 'heart-outline'}
            size={22}
            color={mine ? 'primary' : 'textMuted'}
          />
          <Text variant="label" tone={mine ? 'primary' : 'default'}>
            {mineInfo ? mineInfo.label : 'Like'}
          </Text>
        </Pressable>
        {enabled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={picking ? 'Close reactions' : 'Choose a reaction'}
            accessibilityState={{ expanded: picking }}
            onPress={() => setPicking((p) => !p)}
            style={styles.button}
            hitSlop={6}
          >
            <Icon name={picking ? 'close' : 'add-circle-outline'} size={18} color="textMuted" />
          </Pressable>
        ) : null}
        <View style={styles.counts}>
          {counts ? (
            shown.map((r) => (
              <View
                key={r.type}
                style={styles.count}
                accessible
                accessibilityLabel={`${counts[r.type]} ${r.label}`}
                testID={`reaction-count-${r.type}`}
              >
                <Icon name={r.icon} size={14} color={r.type === mine ? 'primary' : 'textMuted'} />
                <Text variant="caption" tone="muted">
                  {counts[r.type]}
                </Text>
              </View>
            ))
          ) : (
            <Text
              variant="caption"
              tone="muted"
              accessibilityLabel={`${total} ${total === 1 ? 'reaction' : 'reactions'}`}
            >
              {total}
            </Text>
          )}
        </View>
      </View>
      {picking ? (
        <View style={styles.picker} accessibilityRole="radiogroup" accessibilityLabel="Reactions">
          {REACTIONS.map((r) => (
            <Pressable
              key={r.type}
              accessibilityRole="radio"
              accessibilityLabel={`React with ${r.label}`}
              accessibilityState={{ checked: r.type === mine }}
              onPress={() => {
                setPicking(false);
                reaction.choose(r.type === mine ? null : r.type);
              }}
              style={[styles.option, r.type === mine && styles.selected]}
            >
              <Icon name={r.icon} size={20} color={r.type === mine ? 'primary' : 'text'} />
              <Text variant="caption">{r.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {reaction.error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {reaction.error}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.xs, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, flexWrap: 'wrap' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xxs,
    minHeight: 32,
    paddingHorizontal: t.spacing.sm,
    borderRadius: t.radius.pill,
  },
  selected: { backgroundColor: t.colors.primarySoft },
  counts: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  count: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs },
  option: {
    alignItems: 'center',
    minWidth: 56,
    paddingVertical: t.spacing.xs,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
}));

import type { ReactNode } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import { makeStyles } from '@/theme';

export interface CardProps extends ViewProps {
  children: ReactNode;
  /** Makes the whole card a button. */
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Highlights the card (e.g. the current choice in a list). */
  selected?: boolean;
  disabled?: boolean;
}

export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
  selected,
  disabled,
  ...rest
}: CardProps) {
  const styles = useStyles();
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: !!selected, disabled: !!disabled }}
        onPress={onPress}
        disabled={disabled}
        testID={rest.testID}
        style={({ pressed }) => [
          styles.card,
          selected && styles.selected,
          pressed && !disabled && styles.pressed,
          disabled && styles.disabled,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View {...rest} style={[styles.card, selected && styles.selected, style]}>
      {children}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: t.spacing.lg,
    gap: t.spacing.sm,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  selected: { borderColor: t.colors.primary, borderWidth: 2, backgroundColor: t.colors.primarySoft },
  disabled: { opacity: 0.6 },
}));

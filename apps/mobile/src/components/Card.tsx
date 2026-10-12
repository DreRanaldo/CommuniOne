import type { ReactNode } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import { makeStyles } from '@/theme';

export interface CardProps extends ViewProps {
  children: ReactNode;
  /** Makes the whole card a button. */
  onPress?: () => void;
  accessibilityLabel?: string;
}

export function Card({ children, onPress, style, accessibilityLabel, ...rest }: CardProps) {
  const styles = useStyles();
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View {...rest} style={[styles.card, style]}>
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
}));

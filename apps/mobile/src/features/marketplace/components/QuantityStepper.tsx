import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';

/** − quantity + (accessible as an adjustable control). */
export function QuantityStepper({
  value,
  min = 1,
  max,
  onChange,
  label,
  disabled,
}: {
  value: number;
  min?: number;
  max: number;
  onChange(value: number): void;
  label: string;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const set = (next: number) => !disabled && next >= min && next <= max && next !== value && onChange(next);
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => set(e.nativeEvent.actionName === 'increment' ? value + 1 : value - 1)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Fewer: ${label}`}
        onPress={() => set(value - 1)}
        disabled={disabled || value <= min}
        style={[styles.button, (disabled || value <= min) && styles.off]}
        hitSlop={6}
      >
        <Icon name="remove" size={18} color="text" />
      </Pressable>
      <Text variant="bodyStrong" style={styles.value}>
        {value}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More: ${label}`}
        onPress={() => set(value + 1)}
        disabled={disabled || value >= max}
        style={[styles.button, (disabled || value >= max) && styles.off]}
        hitSlop={6}
      >
        <Icon name="add" size={18} color="text" />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  button: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.35 },
  value: { minWidth: 28, textAlign: 'center' },
}));

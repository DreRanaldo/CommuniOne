import { Pressable, ScrollView } from 'react-native';
import { Text } from '@/components';
import { makeStyles } from '@/theme';

/** A horizontal row of single-choice chips (categories, sort, kind, condition). */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  label,
  testID,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
  label: string;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={[styles.chip, selected && styles.selected]}
          >
            <Text variant="label" tone={selected ? 'inverse' : 'default'}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((t) => ({
  row: { gap: t.spacing.xs, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.xs },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.background,
  },
  selected: { backgroundColor: t.colors.text, borderColor: t.colors.text },
}));

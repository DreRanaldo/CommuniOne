import { COMMUNITY_TYPES, type CommunityType } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Text } from '@/components';
import { makeStyles } from '@/theme';

const LABELS: Record<CommunityType, string> = {
  residential: 'Residential',
  church: 'Church',
  school: 'School',
  club: 'Club',
  association: 'Association',
  organization: 'Organization',
  other: 'Other',
};

/** Community type as a radio group of chips. */
export function TypePicker({
  value,
  onChange,
  error,
}: {
  value: CommunityType;
  onChange(type: CommunityType): void;
  error?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.container}>
      <Text variant="label" nativeID="community-type-label">
        Community type
      </Text>
      <View
        style={styles.chips}
        accessibilityRole="radiogroup"
        accessibilityLabelledBy="community-type-label"
      >
        {COMMUNITY_TYPES.map((type) => {
          const selected = type === value;
          return (
            <Pressable
              key={type}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={LABELS[type]}
              onPress={() => onChange(type)}
              style={[styles.chip, selected && styles.selected]}
            >
              <Text variant="label" tone={selected ? 'inverse' : 'default'}>
                {LABELS[type]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.xs, alignSelf: 'stretch' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  chip: {
    minHeight: t.touchTarget,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  selected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
}));

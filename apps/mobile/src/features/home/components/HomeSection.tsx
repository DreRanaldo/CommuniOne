import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Button, SectionHeader, Text, type IconName } from '@/components';
import { makeStyles } from '@/theme';
import { errorMessage, isNetworkError } from '@/utils/errors';
import type { SectionResult } from '../useCommunityHome';

export interface HomeSectionProps<T> {
  title: string;
  icon: IconName;
  result: SectionResult<T>;
  /** Shown when the section has no items. */
  empty: string;
  renderItem(item: T): ReactNode;
  onSeeAll?: () => void;
  onRetry(): void;
  testID?: string;
}

/**
 * One summary section of the community home: a header, up to a few items, a
 * one-line empty message, or an inline error with retry (a failing section
 * never hides the others).
 */
export function HomeSection<T>({
  title,
  icon,
  result,
  empty,
  renderItem,
  onSeeAll,
  onRetry,
  testID,
}: HomeSectionProps<T>) {
  const styles = useStyles();
  return (
    <View style={styles.section} testID={testID}>
      <SectionHeader
        title={title}
        icon={icon}
        action={
          onSeeAll
            ? { title: 'See all', onPress: onSeeAll, accessibilityLabel: `See all ${title.toLowerCase()}` }
            : undefined
        }
      />
      {result.items === undefined ? (
        <View style={styles.error}>
          <Text tone="danger" accessibilityRole="alert">
            {isNetworkError(result.error)
              ? `Couldn't load ${title.toLowerCase()} while offline.`
              : errorMessage(result.error)}
          </Text>
          <Button
            title="Try again"
            variant="secondary"
            fullWidth={false}
            onPress={onRetry}
            accessibilityLabel={`Try loading ${title.toLowerCase()} again`}
          />
        </View>
      ) : result.items.length === 0 ? (
        <Text tone="muted">{empty}</Text>
      ) : (
        result.items.map((item) => renderItem(item))
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  section: { gap: t.spacing.sm },
  error: { gap: t.spacing.sm, alignItems: 'flex-start' },
}));

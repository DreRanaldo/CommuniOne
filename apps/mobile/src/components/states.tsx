// Loading, error and empty states: every screen shows these the same way.
import { ActivityIndicator, View } from 'react-native';
import { makeStyles, useTheme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      testID="loading-state"
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text tone="muted">{label}</Text>
    </View>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: ErrorStateProps) {
  const styles = useStyles();
  return (
    <View style={styles.container} testID="error-state">
      <Icon name="alert-circle-outline" size={40} color="danger" />
      <Text variant="heading" align="center">
        {title}
      </Text>
      <Text tone="muted" align="center" accessibilityRole="alert" accessibilityLiveRegion="polite">
        {message}
      </Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} fullWidth={false} /> : null}
    </View>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  message?: string;
  action?: { title: string; onPress: () => void };
}

export function EmptyState({ icon = 'leaf-outline', title, message, action }: EmptyStateProps) {
  const styles = useStyles();
  return (
    <View style={styles.container} testID="empty-state">
      <Icon name={icon} size={40} color="textMuted" />
      <Text variant="heading" align="center">
        {title}
      </Text>
      {message ? (
        <Text tone="muted" align="center">
          {message}
        </Text>
      ) : null}
      {action ? <Button title={action.title} onPress={action.onPress} fullWidth={false} /> : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.md,
    padding: t.spacing.xl,
  },
}));

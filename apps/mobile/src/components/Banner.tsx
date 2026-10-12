import { Pressable, View } from 'react-native';
import { makeStyles, useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type BannerTone = 'info' | 'success' | 'danger';

export interface BannerProps {
  tone?: BannerTone;
  title?: string;
  message: string;
  onDismiss?: () => void;
  testID?: string;
}

const ICONS: Record<BannerTone, IconName> = {
  info: 'information-circle-outline',
  success: 'checkmark-circle-outline',
  danger: 'alert-circle-outline',
};

/** An inline message (session expired, link problem, saved…). Errors are announced to screen readers. */
export function Banner({ tone = 'info', title, message, onDismiss, testID }: BannerProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = tone === 'danger' ? colors.danger : tone === 'success' ? colors.success : colors.primary;
  return (
    <View
      style={[styles.banner, { borderColor: color }]}
      testID={testID}
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
      accessible
      accessibilityLabel={[title, message].filter(Boolean).join('. ')}
    >
      <Icon name={ICONS[tone]} color={color} />
      <View style={styles.text}>
        {title ? <Text variant="bodyStrong">{title}</Text> : null}
        <Text variant="label" tone="muted">
          {message}
        </Text>
      </View>
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} hitSlop={12}>
          <Icon name="close" size={20} color="textMuted" />
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    backgroundColor: t.colors.surface,
    alignSelf: 'stretch',
  },
  text: { flex: 1, gap: t.spacing.xxs },
}));

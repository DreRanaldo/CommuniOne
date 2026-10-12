import { ActivityIndicator, Pressable, View, type PressableProps } from 'react-native';
import { makeStyles, useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: IconName;
  fullWidth?: boolean;
}

export function Button({
  title,
  variant = 'primary',
  loading = false,
  disabled,
  icon,
  fullWidth = true,
  ...rest
}: ButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const inactive = disabled || loading;
  const foreground = {
    primary: colors.onPrimary,
    secondary: colors.primary,
    ghost: colors.primary,
    danger: colors.textInverse,
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: loading }}
      accessibilityLabel={title}
      disabled={inactive}
      {...rest}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && !inactive && styles[`${variant}Pressed`],
        inactive && styles.inactive,
        !fullWidth && styles.inline,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={foreground} testID="button-loading" />
        ) : (
          <>
            {icon ? <Icon name={icon} size={20} color={foreground} /> : null}
            <Text variant="bodyStrong" style={{ color: foreground }}>
              {title}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  base: {
    minHeight: t.touchTarget,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.lg,
    justifyContent: 'center',
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  inline: { alignSelf: 'flex-start' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm },
  primary: { backgroundColor: t.colors.primary },
  primaryPressed: { backgroundColor: t.colors.primaryPressed },
  secondary: { backgroundColor: t.colors.surface, borderColor: t.colors.primary },
  secondaryPressed: { backgroundColor: t.colors.primarySoft },
  ghost: { backgroundColor: 'transparent' },
  ghostPressed: { backgroundColor: t.colors.primarySoft },
  danger: { backgroundColor: t.colors.danger },
  dangerPressed: { opacity: 0.85 },
  inactive: { opacity: 0.5 },
}));

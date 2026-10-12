import type { ReactNode } from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme, type TypographyVariant } from '@/theme';

export interface TextProps extends RNTextProps {
  variant?: TypographyVariant;
  tone?: 'default' | 'muted' | 'primary' | 'danger' | 'success' | 'inverse';
  align?: 'auto' | 'left' | 'center' | 'right';
  children?: ReactNode;
}

/** All text in the app goes through this component, so type scale and colours stay consistent. */
export function Text({ variant = 'body', tone = 'default', align, style, ...rest }: TextProps) {
  const { colors, typography } = useTheme();
  const color = {
    default: colors.text,
    muted: colors.textMuted,
    primary: colors.primary,
    danger: colors.danger,
    success: colors.success,
    inverse: colors.textInverse,
  }[tone];
  return (
    <RNText
      accessibilityRole={variant === 'display' || variant === 'title' ? 'header' : undefined}
      {...rest}
      style={[typography[variant], { color, textAlign: align }, style]}
    />
  );
}

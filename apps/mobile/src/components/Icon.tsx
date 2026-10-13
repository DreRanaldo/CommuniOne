import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { useTheme, type ColorTokens } from '@/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  /** A theme colour key, or an explicit colour from the theme. */
  color?: keyof Omit<ColorTokens, 'severity' | 'tints'> | (string & {});
  accessibilityLabel?: string;
}

/** One icon family (Ionicons, bundled with Expo) for a consistent look. Decorative unless labelled. */
export function Icon({ name, size = 22, color = 'text', accessibilityLabel }: IconProps) {
  const { colors } = useTheme();
  const resolved = color in colors ? (colors[color as keyof ColorTokens] as string) : color;
  return (
    <Ionicons
      name={name}
      size={size}
      color={resolved}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
    />
  );
}

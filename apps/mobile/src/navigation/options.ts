// Shared navigator styling derived from the theme (no per-screen styling).
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from '@react-navigation/native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { useTheme, type Theme } from '@/theme';

export function navigationTheme(theme: Theme): NavigationTheme {
  const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.danger,
    },
  };
}

export function useStackOptions(): NativeStackNavigationOptions {
  const { colors, typography } = useTheme();
  return useMemo(
    () => ({
      headerStyle: { backgroundColor: colors.surface },
      headerTintColor: colors.primary,
      headerTitleStyle: {
        color: colors.text,
        fontSize: typography.heading.fontSize,
        fontWeight: typography.heading.fontWeight,
      },
      contentStyle: { backgroundColor: colors.background },
      headerBackButtonDisplayMode: 'minimal',
    }),
    [colors, typography],
  );
}

export function useTabOptions(): BottomTabNavigationOptions {
  const { colors } = useTheme();
  return useMemo(
    () => ({
      headerStyle: { backgroundColor: colors.surface },
      headerTitleStyle: { color: colors.text },
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.textMuted,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
    }),
    [colors],
  );
}

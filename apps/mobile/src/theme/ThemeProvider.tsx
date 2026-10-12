import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { darkTheme, lightTheme, type Theme } from './tokens';

const ThemeContext = createContext<Theme>(lightTheme);

/** Follows the system light/dark setting unless a scheme is forced (tests, previews). */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: 'light' | 'dark' }) {
  const system = useColorScheme();
  const theme = (scheme ?? system) === 'dark' ? darkTheme : lightTheme;
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Theme-aware StyleSheet: styles are written once as a function of the
 * theme and recomputed only when the theme changes.
 *
 *   const useStyles = makeStyles((t) => ({ box: { padding: t.spacing.lg } }));
 *   const styles = useStyles();
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (theme: Theme) => T): () => T {
  return function useStyles() {
    const theme = useTheme();
    return useMemo(() => StyleSheet.create(factory(theme)), [theme]);
  };
}

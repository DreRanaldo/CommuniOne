// Design tokens: the single source of colours, type, spacing and shape.
// Components read these through useTheme(); no screen hard-codes a colour,
// font size or spacing value.
//
// Direction: calm, trustworthy and neutral enough for any community (a
// residents' association, a church, a school). One confident blue for
// actions, warm neutrals, generous spacing, and a severity scale reserved for
// safety alerts.

const palette = {
  blue50: '#EEF2FF',
  blue100: '#E0E7FF',
  blue500: '#3B5BDB',
  blue600: '#2F4AC2',
  blue300: '#8DA2FB',
  gray0: '#FFFFFF',
  gray50: '#F6F7FB',
  gray100: '#EEF0F5',
  gray200: '#E1E4EC',
  gray400: '#9AA1B2',
  gray600: '#5A6275',
  gray800: '#283043',
  gray900: '#151A26',
  gray950: '#0F1420',
  gray925: '#1A2030',
  gray875: '#242B3D',
  red500: '#D32F2F',
  red300: '#F28B82',
  amber600: '#B26A00',
  amber300: '#F6C26B',
  orange600: '#C2410C',
  orange300: '#FDBA74',
  green600: '#1E7D4F',
  green300: '#7DD3A8',
} as const;

export interface ColorTokens {
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  textInverse: string;
  primary: string;
  primaryPressed: string;
  primarySoft: string;
  onPrimary: string;
  danger: string;
  success: string;
  focus: string;
  /** Alert severities (Stage 7): info, warning, urgent, emergency. */
  severity: { info: string; warning: string; urgent: string; emergency: string };
}

export const lightColors: ColorTokens = {
  background: palette.gray50,
  surface: palette.gray0,
  surfaceMuted: palette.gray100,
  border: palette.gray200,
  text: palette.gray900,
  textMuted: palette.gray600,
  textInverse: palette.gray0,
  primary: palette.blue500,
  primaryPressed: palette.blue600,
  primarySoft: palette.blue50,
  onPrimary: palette.gray0,
  danger: palette.red500,
  success: palette.green600,
  focus: palette.blue300,
  severity: {
    info: palette.blue500,
    warning: palette.amber600,
    urgent: palette.orange600,
    emergency: palette.red500,
  },
};

export const darkColors: ColorTokens = {
  background: palette.gray950,
  surface: palette.gray925,
  surfaceMuted: palette.gray875,
  border: palette.gray800,
  text: palette.gray50,
  textMuted: palette.gray400,
  textInverse: palette.gray900,
  primary: palette.blue300,
  primaryPressed: palette.blue100,
  primarySoft: palette.gray875,
  onPrimary: palette.gray950,
  danger: palette.red300,
  success: palette.green300,
  focus: palette.blue100,
  severity: {
    info: palette.blue300,
    warning: palette.amber300,
    urgent: palette.orange300,
    emergency: palette.red300,
  },
};

/** 4-point spacing scale. */
export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export type TypographyVariant = 'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'label' | 'caption';

/** System fonts (San Francisco / Roboto): no font download, best legibility. */
export const typography: Record<
  TypographyVariant,
  { fontSize: number; lineHeight: number; fontWeight: '400' | '500' | '600' | '700' }
> = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
};

/** Minimum touch target (Apple HIG 44pt, Material 48dp). */
export const touchTarget = 48;

export interface Theme {
  scheme: 'light' | 'dark';
  colors: ColorTokens;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  touchTarget: number;
}

export const lightTheme: Theme = {
  scheme: 'light',
  colors: lightColors,
  spacing,
  radius,
  typography,
  touchTarget,
};
export const darkTheme: Theme = {
  scheme: 'dark',
  colors: darkColors,
  spacing,
  radius,
  typography,
  touchTarget,
};

// Design tokens: the single source of colours, type, spacing and shape.
// Components read these through useTheme(); no screen hard-codes a colour,
// font size or spacing value.
//
// Direction (feed redesign): a clean, predominantly white interface, close to
// the photo-first feeds people already know, neutral enough for any community
// (a residents' association, a church, a school). Pure white surfaces,
// near-black text, light-gray hairlines and secondary text, the CommuniOne
// logo's blue as the one accent for actions, and a severity scale reserved for
// safety alerts. Light is the app's appearance; the dark tokens are kept for a
// later dark mode but are not used by default.

/** Logo colours (assets/brand). The bright green and orange are decorative only: they fail AA as text. */
export const brand = {
  blue: '#0069CE',
  teal: '#0AA589',
  green: '#04B46B',
  orange: '#F29724',
  navy: '#162B46',
  /** The logo's background (the mark's inner disc is this white). */
  paper: '#FFFFFF',
} as const;

const palette = {
  // Brand blue scale (logo blue #0069CE = blue500: 5.4:1 with white text).
  blue50: '#E8F2FC',
  blue100: '#CFE4F9',
  blue500: brand.blue,
  blue600: '#00559F',
  blue300: '#6FB1F2',
  navy900: brand.navy,
  gray0: '#FFFFFF',
  // Feed redesign neutrals: near-black text, quiet grays.
  ink: '#121417',
  gray25: '#F7F8FA',
  gray150: '#E7E9ED',
  gray550: '#5E6470',
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
  // Emergency severity: deeper than danger so labels pass WCAG AA on muted surfaces too.
  red600: '#C62828',
  red300: '#F28B82',
  // Darkened from #B26A00 (4.24:1 on white) to meet WCAG AA as text (RN-10).
  amber700: '#9C5C00',
  amber300: '#F6C26B',
  orange600: '#C2410C',
  orange300: '#FDBA74',
  // Text-safe greens related to the logo's (the logo green itself is 2.7:1 on white).
  green600: '#06753F',
  green300: '#4CD38E',
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
  /** Translucent dark backdrop for text over photos (counters, badges). */
  scrim: string;
  /** Alert severities (Stage 7): info, warning, urgent, emergency. */
  severity: { info: string; warning: string; urgent: string; emergency: string };
  /**
   * Soft colour pairs (design pass): hub tiles, initials avatars, the alert
   * banner. `fg` is readable as text on `bg` (WCAG AA, see contrast.test).
   */
  tints: Record<TintName, { bg: string; fg: string }>;
  /** The story ring of an unseen story. */
  storyRing: string;
  /** Full-screen photo viewers (stories): a black backdrop with white text in either theme. */
  media: { backdrop: string; text: string; dim: string; track: string; shade: string };
}

export type TintName = 'blue' | 'amber' | 'red' | 'purple' | 'green' | 'teal';

const MEDIA = {
  backdrop: '#000000',
  text: '#FFFFFF',
  dim: 'rgba(255, 255, 255, 0.8)',
  track: 'rgba(255, 255, 255, 0.35)',
  shade: 'rgba(0, 0, 0, 0.45)',
};

export const lightColors: ColorTokens = {
  background: palette.gray0,
  surface: palette.gray0,
  surfaceMuted: palette.gray25,
  border: palette.gray150,
  text: palette.ink,
  textMuted: palette.gray550,
  textInverse: palette.gray0,
  primary: palette.blue500,
  primaryPressed: palette.blue600,
  primarySoft: palette.blue50,
  onPrimary: palette.gray0,
  danger: palette.red500,
  success: palette.green600,
  focus: palette.blue300,
  scrim: 'rgba(18, 20, 23, 0.72)',
  severity: {
    info: palette.blue500,
    warning: palette.amber700,
    urgent: palette.orange600,
    emergency: palette.red600,
  },
  tints: {
    blue: { bg: '#E8F2FC', fg: '#0057B0' },
    amber: { bg: '#FDF3DC', fg: '#8A5300' },
    red: { bg: '#FDECEC', fg: '#B3261E' },
    purple: { bg: '#F1ECFD', fg: '#5B33B8' },
    green: { bg: '#E6F6EE', fg: '#0B6B3A' },
    teal: { bg: '#E3F5F2', fg: '#0B6E61' },
  },
  storyRing: brand.teal,
  media: MEDIA,
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
  scrim: 'rgba(0, 0, 0, 0.72)',
  severity: {
    info: palette.blue300,
    warning: palette.amber300,
    urgent: palette.orange300,
    emergency: palette.red300,
  },
  tints: {
    blue: { bg: '#16263F', fg: '#9CC8F5' },
    amber: { bg: '#2E2412', fg: '#F6C26B' },
    red: { bg: '#331A1C', fg: '#F5A49C' },
    purple: { bg: '#261F3D', fg: '#C7B5F7' },
    green: { bg: '#132B20', fg: '#7FDCAA' },
    teal: { bg: '#11292A', fg: '#7FD8C8' },
  },
  storyRing: brand.teal,
  media: MEDIA,
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

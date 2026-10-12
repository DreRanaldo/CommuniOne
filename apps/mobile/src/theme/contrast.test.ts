// Brand and alert colours must stay readable: WCAG AA (4.5:1) for normal text, in
// both themes, for each severity colour used as text on the app's surfaces,
// and for the emergency banner (inverse text on the emergency colour).
import { darkColors, lightColors, type ColorTokens } from './tokens';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ['light', lightColors],
  ['dark', darkColors],
] as [string, ColorTokens][])('%s theme', (_name, colors) => {
  test.each(['info', 'warning', 'urgent', 'emergency'] as const)(
    '%s text is readable on every surface',
    (severity) => {
      for (const surface of [colors.surface, colors.background, colors.surfaceMuted]) {
        expect(contrast(colors.severity[severity], surface)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  test('brand colours in use: buttons, links, body text and success text are readable', () => {
    expect(contrast(colors.onPrimary, colors.primary)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [colors.surface, colors.background, colors.surfaceMuted]) {
      expect(contrast(colors.primary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.success, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the emergency banner text is readable', () => {
    expect(contrast(colors.textInverse, colors.severity.emergency)).toBeGreaterThanOrEqual(4.5);
  });
});

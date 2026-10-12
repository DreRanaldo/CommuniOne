import { Image, View } from 'react-native';
import { APP_NAME } from '@/constants/app';
import { brand, makeStyles, useTheme } from '@/theme';

// Static image assets are bundled with require().
const MARK = require('../../assets/brand/mark.png');
const WORDMARK = {
  light: require('../../assets/brand/wordmark-light.png'),
  dark: require('../../assets/brand/wordmark-dark.png'),
};

// Intrinsic proportions of the generated assets (scripts/brand-assets.py).
const MARK_RATIO = 518 / 519;
const WORDMARK_RATIO = 1088 / 144;

export interface BrandLogoProps {
  /** `full`: the mark above the "CommuniOne" wordmark; `mark`: the mark alone. */
  variant?: 'full' | 'mark';
  /** Width of the mark in points. */
  size?: number;
  testID?: string;
}

/**
 * The CommuniOne logo. In dark mode the mark sits on a white tile (its inner
 * disc is white in the logo) and the wordmark's navy letters turn white, so it
 * stays legible on dark backgrounds. Read out as one image named "CommuniOne".
 */
export function BrandLogo({ variant = 'full', size = 96, testID }: BrandLogoProps) {
  const styles = useStyles();
  const { scheme } = useTheme();
  const tiled = scheme === 'dark';
  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="image"
      accessibilityLabel={APP_NAME}
      testID={testID}
    >
      <View
        testID="brand-mark-tile"
        style={tiled ? [styles.tile, { padding: size * 0.12, borderRadius: size * 0.28 }] : undefined}
      >
        <Image
          source={MARK}
          testID="brand-mark"
          style={{ width: size, height: size / MARK_RATIO }}
          resizeMode="contain"
        />
      </View>
      {variant === 'full' ? (
        <Image
          source={WORDMARK[scheme]}
          testID="brand-wordmark"
          style={{ width: size * 2.6, height: (size * 2.6) / WORDMARK_RATIO }}
          resizeMode="contain"
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { alignItems: 'center', gap: t.spacing.md },
  tile: { backgroundColor: brand.paper },
}));

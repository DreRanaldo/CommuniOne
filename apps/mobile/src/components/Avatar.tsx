import { useState } from 'react';
import { Image, View } from 'react-native';
import { makeStyles, useTheme, type TintName } from '@/theme';
import { Text } from './Text';

export interface AvatarProps {
  /** Image URL (a signed URL for uploaded avatars) or null for initials. */
  uri: string | null;
  name: string | null;
  size?: number;
  /** Accessibility label; defaults to "Profile picture of {name}". */
  label?: string;
  /** Test id prefix: `{testID}-image` / `{testID}-initials`. */
  testID?: string;
}

const initials = (name: string | null) =>
  (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

const TINTS: TintName[] = ['blue', 'amber', 'green', 'purple', 'teal', 'red'];
/** A stable soft colour per name, so people are recognisable at a glance. */
export const tintFor = (name: string | null): TintName => {
  let hash = 0;
  for (const ch of name ?? '') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length]!;
};

/** A round profile picture, falling back to initials (also when the image fails to load). */
export function Avatar({ uri, name, size = 72, label: customLabel, testID = 'avatar' }: AvatarProps) {
  const styles = useStyles();
  const { typography, colors } = useTheme();
  const tint = colors.tints[tintFor(name)];
  const [failed, setFailed] = useState<string | null>(null);
  const shape = { width: size, height: size, borderRadius: size / 2 };
  const label = customLabel ?? (name ? `Profile picture of ${name}` : 'Profile picture');
  if (uri && failed !== uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, shape]}
        accessibilityRole="image"
        accessibilityLabel={label}
        onError={() => setFailed(uri)}
        testID={`${testID}-image`}
      />
    );
  }
  return (
    <View
      style={[styles.fallback, shape, { backgroundColor: tint.bg }]}
      accessibilityRole="image"
      accessibilityLabel={label}
      testID={`${testID}-initials`}
    >
      <Text
        style={{
          fontSize: size * 0.36,
          lineHeight: size * 0.5,
          fontWeight: typography.title.fontWeight,
          color: tint.fg,
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  image: { backgroundColor: t.colors.surfaceMuted },
  fallback: { backgroundColor: t.colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
}));

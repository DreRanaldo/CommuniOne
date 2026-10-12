import { useState } from 'react';
import { Image, View } from 'react-native';
import { makeStyles, useTheme } from '@/theme';
import { Text } from './Text';

export interface AvatarProps {
  /** Image URL (a signed URL for uploaded avatars) or null for initials. */
  uri: string | null;
  name: string | null;
  size?: number;
}

const initials = (name: string | null) =>
  (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

/** A round profile picture, falling back to initials (also when the image fails to load). */
export function Avatar({ uri, name, size = 72 }: AvatarProps) {
  const styles = useStyles();
  const { typography } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const shape = { width: size, height: size, borderRadius: size / 2 };
  const label = name ? `Profile picture of ${name}` : 'Profile picture';
  if (uri && failed !== uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, shape]}
        accessibilityRole="image"
        accessibilityLabel={label}
        onError={() => setFailed(uri)}
        testID="avatar-image"
      />
    );
  }
  return (
    <View
      style={[styles.fallback, shape]}
      accessibilityRole="image"
      accessibilityLabel={label}
      testID="avatar-initials"
    >
      <Text
        style={{ fontSize: size * 0.38, lineHeight: size * 0.5, fontWeight: typography.title.fontWeight }}
        tone="primary"
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

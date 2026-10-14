import type { ListingCard } from '@communione/services';
import { Image, Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { availabilityLine, CONDITION_LABELS, priceLabel } from '../marketRules';

/**
 * A storefront tile: square picture, title, price, availability or
 * condition, and the seller; a heart to save it. Everything shown comes from
 * the server's search result.
 */
export function ListingTile({
  listing: l,
  width,
  onPress,
  onToggleFavorite,
}: {
  listing: ListingCard;
  width: number;
  onPress(): void;
  onToggleFavorite?(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const stock = availabilityLine(l.kind, l.available);
  const price = priceLabel(l);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[l.title, price, stock?.text, l.sellerName].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { width }, pressed && styles.pressed]}
      testID={`listing-${l.id}`}
    >
      <View style={[styles.picture, { height: width }]}>
        {l.coverUrl ? (
          <Image
            source={{ uri: l.coverUrl }}
            style={styles.image}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Icon
            name={l.kind === 'service' ? 'construct-outline' : 'image-outline'}
            size={36}
            color="textMuted"
          />
        )}
        {onToggleFavorite ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={l.isFavorite ? `Remove ${l.title} from saved` : `Save ${l.title}`}
            accessibilityState={{ selected: l.isFavorite }}
            onPress={onToggleFavorite}
            hitSlop={8}
            style={styles.heart}
          >
            <Icon
              name={l.isFavorite ? 'heart' : 'heart-outline'}
              size={20}
              color={l.isFavorite ? colors.danger : colors.text}
            />
          </Pressable>
        ) : null}
        {l.kind === 'service' ? (
          <View style={styles.badge}>
            <Text variant="caption">Service</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text numberOfLines={2} style={styles.title}>
          {l.title}
        </Text>
        <Text variant="bodyStrong">{price}</Text>
        {stock ? (
          <Text variant="caption" tone={stock.tone}>
            {stock.text}
          </Text>
        ) : l.condition ? (
          <Text variant="caption" tone="muted">
            {CONDITION_LABELS[l.condition]}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {l.sellerVerified ? `${l.sellerName} ✓` : l.sellerName}
        </Text>
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  tile: {
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.background,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.85 },
  picture: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceMuted },
  image: { width: '100%', height: '100%' },
  heart: {
    position: 'absolute',
    top: t.spacing.xs,
    right: t.spacing.xs,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.background,
  },
  badge: {
    position: 'absolute',
    left: t.spacing.xs,
    top: t.spacing.xs,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.background,
  },
  body: { padding: t.spacing.sm, gap: 2 },
  title: { minHeight: 40 },
}));

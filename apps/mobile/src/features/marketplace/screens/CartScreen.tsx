import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CartLine } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Banner, Button, Card, EmptyState, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { QuantityStepper } from '../components/QuantityStepper';
import { formatMoney, marketError } from '../marketRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Cart'>;

const ISSUES: Record<string, string> = {
  unavailable: 'No longer for sale',
  out_of_stock: 'Out of stock',
  insufficient_stock: 'Not enough in stock',
};

/**
 * The cart for the current community (Stage C). Every price, stock figure
 * and total is the server's (cart_quote); quantity changes are checked by
 * the server too.
 */
export function CartScreen({ navigation }: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { cart } = useServices();
  const load = useCallback(() => cart.quote(community.community_id), [cart, community.community_id]);
  const quote = useAsync(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { reload } = quote;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else reload();
    }, [reload]),
  );

  if (!permissions.can('marketplace.buy'))
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Buying is not available"
        message={`You can't buy in ${community.name}.`}
      />
    );
  if (quote.status === 'loading') return <LoadingState label="Loading your cart…" />;
  if (quote.status === 'error')
    return (
      <ErrorState
        title="Your cart could not be loaded"
        message={marketError(quote.error)}
        onRetry={quote.reload}
      />
    );
  const q = quote.data;

  const change = async (line: CartLine, quantity: number) => {
    setBusy(line.listingId);
    setNotice(null);
    try {
      await cart.setQuantity(line.listingId, quantity);
    } catch (thrown) {
      setNotice(marketError(thrown));
    } finally {
      setBusy(null);
      quote.reload();
    }
  };

  if (q.lines.length === 0)
    return (
      <EmptyState
        icon="cart-outline"
        title="Your cart is empty"
        message={`Things you add from ${community.name}'s marketplace appear here.`}
        action={{ title: 'Browse the marketplace', onPress: () => navigation.navigate('Market') }}
      />
    );

  return (
    <Screen testID="cart-screen">
      {notice ? <Banner tone="danger" message={notice} testID="cart-error" /> : null}
      {q.lines.some((l) => l.issue === 'price_changed') ? (
        <Banner
          message="Some prices changed since you added them. The new prices are shown."
          testID="cart-price-changed"
        />
      ) : null}
      {q.sellers.map((group) => (
        <Card key={group.sellerProfileId} testID={`cart-seller-${group.sellerProfileId}`}>
          <View style={styles.row}>
            <Icon name="storefront-outline" size={18} color="primary" />
            <Text variant="label">{`Sold by ${group.sellerName}`}</Text>
          </View>
          {group.lines.map((line) => (
            <View key={line.listingId} style={styles.line} testID={`cart-line-${line.listingId}`}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${line.title}`}
                onPress={() => navigation.navigate('Listing', { listingId: line.listingId })}
                style={styles.thumb}
              >
                {line.coverUrl ? (
                  <Image source={{ uri: line.coverUrl }} style={styles.thumbImage} />
                ) : (
                  <Icon name="image-outline" size={22} color="textMuted" />
                )}
              </Pressable>
              <View style={styles.flex}>
                <Text variant="bodyStrong" numberOfLines={2}>
                  {line.title}
                </Text>
                {line.unitPriceMinor !== null ? (
                  <Text>
                    {formatMoney(line.unitPriceMinor, line.currency)}
                    {line.issue === 'price_changed' ? (
                      <Text
                        tone="muted"
                        variant="caption"
                      >{`  (was ${formatMoney(line.seenPriceMinor, line.currency)})`}</Text>
                    ) : null}
                  </Text>
                ) : null}
                {line.issue && ISSUES[line.issue] ? (
                  <Text tone="danger" variant="caption" testID={`cart-issue-${line.listingId}`}>
                    {line.issue === 'insufficient_stock' ? `Only ${line.available} left` : ISSUES[line.issue]}
                  </Text>
                ) : null}
                <View style={styles.controls}>
                  {line.issue !== 'unavailable' && line.issue !== 'out_of_stock' ? (
                    <QuantityStepper
                      value={line.quantity}
                      max={Math.max(Math.min(line.available, 99), line.quantity)}
                      onChange={(n) => void change(line, n)}
                      label={`Quantity of ${line.title}`}
                      disabled={busy !== null}
                    />
                  ) : null}
                  <Button
                    title="Remove"
                    variant="ghost"
                    fullWidth={false}
                    disabled={busy !== null}
                    onPress={() => void change(line, 0)}
                  />
                </View>
              </View>
            </View>
          ))}
        </Card>
      ))}
      <Card testID="cart-summary">
        <View style={styles.total}>
          <Text
            variant="heading"
            style={styles.flex}
          >{`Subtotal (${q.itemCount} item${q.itemCount === 1 ? '' : 's'})`}</Text>
          <Text variant="heading" testID="cart-subtotal">
            {formatMoney(q.subtotalMinor, q.currency)}
          </Text>
        </View>
        <Text variant="caption" tone="muted">
          Delivery and tax are calculated at checkout.
        </Text>
        {!q.ready ? (
          <Text tone="danger" variant="caption">
            Remove or change the items that can&apos;t be bought before checking out.
          </Text>
        ) : null}
        <Button
          title="Proceed to checkout"
          disabled={!q.ready}
          onPress={() => navigation.navigate('Checkout')}
          testID="cart-checkout"
        />
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  line: {
    flexDirection: 'row',
    gap: t.spacing.md,
    paddingTop: t.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: t.radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  thumbImage: { width: '100%', height: '100%' },
  flex: { flex: 1, gap: 2 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.xs },
  total: { flexDirection: 'row', alignItems: 'center' },
}));

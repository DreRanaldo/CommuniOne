import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SellerProfile } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Screen,
  Text,
  TextField,
} from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { availabilityLine, canSell, marketError, priceLabel } from '../marketRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Shop'>;

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Live',
  paused: 'Paused',
  removed: 'Removed',
};

/**
 * "Your shop" (marketplace.sell): open a shop in this community, edit it,
 * pause it, and see every listing with its status and stock.
 */
export function ShopScreen({ navigation }: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { marketplace } = useServices();
  const load = useCallback(async () => {
    const seller = await marketplace.mySellerProfile(community.community_id);
    const listings = seller ? await marketplace.myListings(community.community_id) : [];
    return { seller, listings };
  }, [marketplace, community.community_id]);
  const shop = useAsync(load);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);

  const { reload } = shop;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else reload();
    }, [reload]),
  );

  if (!canSell(permissions.can)) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Selling is not available"
        message={`You can't sell in ${community.name}.`}
      />
    );
  }
  if (shop.status === 'loading') return <LoadingState label="Loading your shop…" />;
  if (shop.status === 'error')
    return (
      <ErrorState
        title="Your shop could not be loaded"
        message={marketError(shop.error)}
        onRetry={shop.reload}
      />
    );
  const { seller, listings } = shop.data;

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await marketplace.saveSellerProfile(community.community_id, {
        displayName: name,
        bio: bio.trim() || null,
      });
      setEditing(false);
      setNotice({
        tone: 'success',
        message: seller ? 'Shop updated.' : 'Your shop is open. List your first item.',
      });
      shop.reload();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: marketError(thrown) });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (s: SellerProfile, status: 'active' | 'paused') => {
    setBusy(true);
    setNotice(null);
    try {
      await marketplace.setSellerStatus(s.id, status);
      shop.reload();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: marketError(thrown) });
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <Card testID="shop-form">
      <TextField label="Shop name" value={name} onChangeText={setName} maxLength={80} />
      <TextField
        label="About your shop (optional)"
        value={bio}
        onChangeText={setBio}
        maxLength={1000}
        multiline
      />
      <Button
        title={seller ? 'Save shop' : 'Open my shop'}
        loading={busy}
        disabled={!name.trim()}
        onPress={() => void save()}
      />
      {seller ? <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} /> : null}
    </Card>
  );

  return (
    <Screen testID="shop-screen">
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'danger' ? 'shop-error' : 'shop-done'}
        />
      ) : null}
      {!seller ? (
        <>
          <Text variant="title">Sell in {community.name}</Text>
          <Text tone="muted">
            Open a shop to list products and services for your neighbours. Only members of {community.name}{' '}
            can see them.
          </Text>
          {form}
        </>
      ) : (
        <>
          {editing ? (
            form
          ) : (
            <Card testID="shop-card">
              <View style={styles.row}>
                <Icon name="storefront-outline" size={28} color="primary" />
                <View style={styles.flex}>
                  <Text variant="heading">{seller.displayName}</Text>
                  <Text
                    variant="caption"
                    tone={seller.status === 'suspended' ? 'danger' : 'muted'}
                    testID="shop-status"
                  >
                    {seller.status === 'active'
                      ? 'Open'
                      : seller.status === 'paused'
                        ? 'Paused: your listings are hidden'
                        : 'Suspended by a community admin'}
                    {seller.verified ? ' · Verified' : ''}
                  </Text>
                </View>
              </View>
              {seller.bio ? <Text>{seller.bio}</Text> : null}
              <View style={styles.actions}>
                <Button
                  title="Edit shop"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => {
                    setName(seller.displayName);
                    setBio(seller.bio ?? '');
                    setEditing(true);
                  }}
                />
                {seller.status === 'active' ? (
                  <Button
                    title="Pause shop"
                    variant="ghost"
                    fullWidth={false}
                    disabled={busy}
                    onPress={() => void setStatus(seller, 'paused')}
                  />
                ) : seller.status === 'paused' ? (
                  <Button
                    title="Reopen shop"
                    variant="ghost"
                    fullWidth={false}
                    disabled={busy}
                    onPress={() => void setStatus(seller, 'active')}
                  />
                ) : null}
              </View>
            </Card>
          )}
          {seller.status !== 'suspended' ? (
            <Button title="New listing" icon="add" onPress={() => navigation.navigate('ListingEditor')} />
          ) : null}
          <View style={styles.shopLinks}>
            <Button
              title="Sales"
              icon="receipt-outline"
              variant="secondary"
              fullWidth={false}
              onPress={() => navigation.navigate('Orders', { side: 'sales' })}
              testID="shop-sales"
            />
            <Button
              title="Delivery"
              icon="bicycle-outline"
              variant="secondary"
              fullWidth={false}
              onPress={() => navigation.navigate('DeliverySettings', { sellerProfileId: seller.id })}
              testID="shop-delivery"
            />
            <Button
              title="Hours"
              icon="time-outline"
              variant="secondary"
              fullWidth={false}
              onPress={() => navigation.navigate('ServiceHours', { sellerProfileId: seller.id })}
              testID="shop-hours"
            />
          </View>
          <Text variant="heading" accessibilityRole="header">
            Your listings
          </Text>
          {listings.length === 0 ? (
            <Text tone="muted" testID="shop-empty">
              Nothing listed yet.
            </Text>
          ) : (
            listings.map((l) => {
              const stock = availabilityLine(l.kind, l.available);
              return (
                <Pressable
                  key={l.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${l.title}, ${STATUS_LABELS[l.status]}`}
                  onPress={() => navigation.navigate('Listing', { listingId: l.id })}
                  style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                  testID={`shop-listing-${l.id}`}
                >
                  <View style={styles.thumb}>
                    {l.coverUrl ? (
                      <Image source={{ uri: l.coverUrl }} style={styles.thumbImage} />
                    ) : (
                      <Icon
                        name={l.kind === 'service' ? 'construct-outline' : 'image-outline'}
                        size={22}
                        color="textMuted"
                      />
                    )}
                  </View>
                  <View style={styles.flex}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {l.title}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {[
                        STATUS_LABELS[l.status],
                        priceLabel({ pricing: l.pricing, priceMinor: l.price_minor, currency: l.currency }),
                        l.kind === 'product' ? `${l.available ?? 0} available` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    {stock?.tone === 'danger' && l.status === 'active' ? (
                      <Text variant="caption" tone="danger">
                        {stock.text}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name="chevron-forward" size={18} color="textMuted" />
                </Pressable>
              );
            })
          )}
        </>
      )}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  shopLinks: { flexDirection: 'row', gap: t.spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  flex: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.sm,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: t.radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  thumbImage: { width: '100%', height: '100%' },
}));

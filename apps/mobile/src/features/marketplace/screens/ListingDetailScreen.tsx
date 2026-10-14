import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ListingDetail } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Image, Pressable, View, useWindowDimensions } from 'react-native';
import { Banner, Button, Card, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import {
  availabilityLine,
  canModerate,
  CONDITION_LABELS,
  FULFILLMENT_LABELS,
  marketError,
  priceLabel,
} from '../marketRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Listing'>;
type Notice = { tone: 'success' | 'danger'; message: string };

const STATUS_NOTE: Record<string, string> = {
  draft: 'Draft: only you can see it. Publish it to show it in the marketplace.',
  paused: 'Paused: hidden from the marketplace until you resume it.',
  removed: 'Removed: no longer in the marketplace.',
};

/** One listing, read from the server; must belong to the current community. */
export function ListingDetailScreen({ navigation, route }: Props) {
  const { marketplace } = useServices();
  const community = useCommunity();
  const { listingId } = route.params;
  const load = useCallback(async () => {
    const detail = await marketplace.listing(listingId);
    if (detail.listing.community_id !== community.community_id) throw new Error('not in this community');
    return detail;
  }, [marketplace, listingId, community.community_id]);
  const current = useAsync(load);

  const { reload } = current;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else reload();
    }, [reload]),
  );

  if (current.status === 'loading') return <LoadingState label="Loading the listing…" />;
  if (current.status === 'error')
    return <ErrorState title="This listing is not available" message="It may have been removed or sold." />;
  return (
    <Detail
      key={`${current.data.listing.id}:${current.data.listing.updated_at}`}
      detail={current.data}
      onReload={current.reload}
      onEdit={() => navigation.navigate('ListingEditor', { listingId })}
      onOpenSeller={(sellerProfileId) => navigation.navigate('Seller', { sellerProfileId })}
      warning={route.params.warning}
    />
  );
}

function Detail({
  detail,
  onReload,
  onEdit,
  onOpenSeller,
  warning,
}: {
  warning?: string;
  detail: ListingDetail;
  onReload(): void;
  onEdit(): void;
  onOpenSeller(id: string): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const { marketplace } = useServices();
  const permissions = useCommunityPermissions();
  const [saved, setSaved] = useState(detail.isFavorite);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(warning ? { tone: 'danger', message: warning } : null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reason, setReason] = useState('');
  const l = detail.listing;
  const listingLike = { pricing: l.pricing, priceMinor: l.price_minor, currency: l.currency };
  const stock = availabilityLine(l.kind, detail.stock?.available ?? null);
  const moderator = !detail.isMine && canModerate(permissions.can) && l.status !== 'removed';

  const toggleSaved = async () => {
    setNotice(null);
    setSaved(!saved);
    try {
      await marketplace.setFavorite(l.id, !saved);
    } catch (thrown) {
      setSaved(saved);
      setNotice({ tone: 'danger', message: marketError(thrown) });
    }
  };

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await run();
      setNotice({ tone: 'success', message: done });
      onReload();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: marketError(thrown) });
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  return (
    <Screen testID="listing-screen" padded={false}>
      <View>
        {detail.images.length > 0 ? (
          <FlatList
            data={detail.images}
            keyExtractor={(i) => i.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index }) =>
              item.url ? (
                <Image
                  source={{ uri: item.url }}
                  style={{ width, height: width }}
                  resizeMode="cover"
                  accessibilityRole="image"
                  accessibilityLabel={`Picture ${index + 1} of ${detail.images.length}`}
                  testID="listing-picture"
                />
              ) : (
                <View style={[styles.placeholder, { width, height: width }]} />
              )
            }
            testID="listing-gallery"
          />
        ) : (
          <View style={[styles.placeholder, { width, height: width * 0.6 }]}>
            <Icon
              name={l.kind === 'service' ? 'construct-outline' : 'image-outline'}
              size={48}
              color="textMuted"
            />
          </View>
        )}
        {detail.images.length > 1 ? (
          <View style={styles.counter}>
            <Text variant="caption" tone="inverse">{`${page + 1}/${detail.images.length}`}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        {notice ? (
          <Banner
            tone={notice.tone}
            message={notice.message}
            testID={notice.tone === 'danger' ? 'listing-error' : 'listing-done'}
          />
        ) : null}
        {STATUS_NOTE[l.status] ? <Banner message={STATUS_NOTE[l.status]!} testID="listing-status" /> : null}
        {l.status === 'removed' && l.removal_reason ? (
          <Text tone="muted">{`Reason: ${l.removal_reason}`}</Text>
        ) : null}

        <View style={styles.titleRow}>
          <Text variant="title" style={styles.flex}>
            {l.title}
          </Text>
          {!detail.isMine ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={saved ? 'Remove from saved' : 'Save'}
              accessibilityState={{ selected: saved }}
              onPress={() => void toggleSaved()}
              style={styles.heart}
              testID="listing-save"
            >
              <Icon
                name={saved ? 'heart' : 'heart-outline'}
                size={24}
                color={saved ? colors.danger : colors.text}
              />
            </Pressable>
          ) : null}
        </View>
        <Text variant="display" testID="listing-price">
          {priceLabel(listingLike)}
        </Text>
        {stock ? (
          <Text variant="bodyStrong" tone={stock.tone} testID="listing-availability">
            {stock.text}
          </Text>
        ) : null}

        <Card>
          <Row label="Category" value={detail.category?.name ?? '—'} />
          {l.condition ? (
            <Row label="Condition" value={CONDITION_LABELS[l.condition] ?? l.condition} />
          ) : null}
          {l.kind === 'product' ? (
            <Row label="Delivery" value={l.fulfillment.map((f) => FULFILLMENT_LABELS[f] ?? f).join(' · ')} />
          ) : null}
          {l.pickup_area ? <Row label="Pickup area" value={l.pickup_area} /> : null}
          {l.service_area ? <Row label="Service area" value={l.service_area} /> : null}
        </Card>

        {l.description ? (
          <>
            <Text variant="heading" accessibilityRole="header">
              About this {l.kind === 'service' ? 'service' : 'item'}
            </Text>
            <Text>{l.description}</Text>
          </>
        ) : null}

        {detail.seller ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Seller: ${detail.seller.displayName}`}
            onPress={() => onOpenSeller(detail.seller!.id)}
            style={styles.seller}
            testID="listing-seller"
          >
            <Icon name="storefront-outline" size={24} color="primary" />
            <View style={styles.flex}>
              <Text variant="caption" tone="muted">
                Sold by
              </Text>
              <Text variant="bodyStrong">
                {detail.seller.verified ? `${detail.seller.displayName} ✓` : detail.seller.displayName}
              </Text>
            </View>
            <Icon name="chevron-forward" size={18} color="textMuted" />
          </Pressable>
        ) : null}

        {!detail.isMine ? (
          <Text variant="caption" tone="muted" testID="listing-checkout-note">
            Buying in the app (cart, checkout and payment) arrives in a later update.
          </Text>
        ) : null}

        {detail.isMine && l.status !== 'removed' ? (
          <Card testID="listing-owner-controls">
            <Text variant="label" tone="muted">
              Your listing
            </Text>
            {detail.stock ? (
              <Text testID="listing-stock">{`Stock: ${detail.stock.onHand}${detail.stock.reserved ? ` (${detail.stock.reserved} reserved)` : ''}`}</Text>
            ) : null}
            <View style={styles.actions}>
              <Button title="Edit" variant="secondary" fullWidth={false} onPress={onEdit} disabled={busy} />
              {l.status === 'active' ? (
                <Button
                  title="Pause"
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy}
                  onPress={() =>
                    void act(
                      () => marketplace.setListingStatus(l.id, 'paused'),
                      'Paused. It is hidden from the marketplace.',
                    )
                  }
                />
              ) : (
                <Button
                  title={l.status === 'draft' ? 'Publish' : 'Resume'}
                  fullWidth={false}
                  disabled={busy}
                  onPress={() =>
                    void act(
                      () => marketplace.setListingStatus(l.id, 'active'),
                      'Published. Members can see it now.',
                    )
                  }
                />
              )}
              {confirmRemove ? null : (
                <Button
                  title="Remove"
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy}
                  onPress={() => setConfirmRemove(true)}
                />
              )}
            </View>
            {confirmRemove ? (
              <View style={styles.confirm}>
                <Text>Remove this listing? It leaves the marketplace for good.</Text>
                <View style={styles.actions}>
                  <Button
                    title="Remove listing"
                    variant="danger"
                    fullWidth={false}
                    loading={busy}
                    onPress={() => void act(() => marketplace.setListingStatus(l.id, 'removed'), 'Removed.')}
                  />
                  <Button
                    title="Keep"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setConfirmRemove(false)}
                  />
                </View>
              </View>
            ) : null}
          </Card>
        ) : null}

        {moderator ? (
          <Card testID="listing-moderation">
            <Text variant="label" tone="muted">
              Moderation
            </Text>
            {confirmRemove ? (
              <View style={styles.confirm}>
                <TextField
                  label="Reason for removing"
                  value={reason}
                  onChangeText={setReason}
                  maxLength={500}
                />
                <View style={styles.actions}>
                  <Button
                    title="Remove listing"
                    variant="danger"
                    fullWidth={false}
                    loading={busy}
                    disabled={!reason.trim()}
                    onPress={() =>
                      void act(() => marketplace.moderateRemove(l.id, reason.trim()), 'Listing removed.')
                    }
                  />
                  <Button
                    title="Keep"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setConfirmRemove(false)}
                  />
                </View>
              </View>
            ) : (
              <Button
                title="Remove this listing"
                variant="secondary"
                onPress={() => setConfirmRemove(true)}
              />
            )}
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text tone="muted" style={styles.rowLabel}>
        {label}
      </Text>
      <Text style={styles.flex}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  body: { gap: t.spacing.md, padding: t.spacing.lg },
  placeholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceMuted },
  counter: {
    position: 'absolute',
    right: t.spacing.md,
    bottom: t.spacing.md,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.scrim,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
  flex: { flex: 1 },
  heart: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: t.spacing.md, paddingVertical: t.spacing.xs },
  rowLabel: { width: 110 },
  seller: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  confirm: { gap: t.spacing.sm },
}));

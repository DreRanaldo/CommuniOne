import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  LISTING_MAX_IMAGES,
  type Category,
  type ListingDetail,
  type ListingImage,
  type ListingKind,
} from '@communione/services';
import { useCallback, useState } from 'react';
import { Image, Pressable, Switch, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useDependencies } from '@/lib/dependencies';
import { CameraUnavailableError, type PickedImage } from '@/lib/media';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { ChipRow } from '../components/ChipRow';
import { CONDITION_LABELS, FULFILLMENT_LABELS, marketError, parsePrice, priceInput } from '../marketRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'ListingEditor'>;
type Condition = 'new' | 'like_new' | 'good' | 'fair';
type Pricing = 'fixed' | 'hourly' | 'quote';

/** New listing, or edit one of yours (`listingId`). The server checks every rule again. */
export function ListingEditorScreen({ navigation, route }: Props) {
  const { services } = useDependencies();
  const community = useCommunity();
  const listingId = route.params?.listingId;
  const load = useCallback(async () => {
    const [categories, detail] = await Promise.all([
      services.marketplace.categories(),
      listingId ? services.marketplace.listing(listingId) : Promise.resolve(null),
    ]);
    if (detail && (!detail.isMine || detail.listing.community_id !== community.community_id))
      throw new Error('not your listing');
    return { categories, detail };
  }, [services, listingId, community.community_id]);
  const loaded = useAsync(load);
  if (loaded.status === 'loading') return <LoadingState label="Loading…" />;
  if (loaded.status === 'error')
    return <ErrorState title="This listing can't be edited" message={marketError(loaded.error)} />;
  return (
    <Editor
      categories={loaded.data.categories}
      detail={loaded.data.detail}
      onDone={(id, created, warning) =>
        created ? navigation.replace('Listing', { listingId: id, warning }) : navigation.goBack()
      }
    />
  );
}

function Editor({
  categories,
  detail,
  onDone,
}: {
  categories: Category[];
  detail: ListingDetail | null;
  onDone(listingId: string, created: boolean, warning?: string): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const { services, media } = useDependencies();
  const l = detail?.listing;
  const [kind, setKind] = useState<ListingKind>((l?.kind as ListingKind | undefined) ?? 'product');
  const [categoryId, setCategoryId] = useState(l?.category_id ?? '');
  const [title, setTitle] = useState(l?.title ?? '');
  const [description, setDescription] = useState(l?.description ?? '');
  const [condition, setCondition] = useState<Condition>(
    (l?.condition as Condition | null | undefined) ?? 'good',
  );
  const [pricing, setPricing] = useState<Pricing>((l?.pricing as Pricing | undefined) ?? 'fixed');
  const [priceText, setPriceText] = useState(priceInput(l?.price_minor ?? null));
  const [pickup, setPickup] = useState(l ? l.fulfillment.includes('pickup') : true);
  const [delivery, setDelivery] = useState(l ? l.fulfillment.includes('seller_delivery') : false);
  const [area, setArea] = useState((l?.kind === 'service' ? l.service_area : l?.pickup_area) ?? '');
  const [stockText, setStockText] = useState(detail?.stock ? String(detail.stock.onHand) : '1');
  const [existing, setExisting] = useState<ListingImage[]>(detail?.images ?? []);
  const [pending, setPending] = useState<PickedImage[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!l;
  const photoCount = existing.length + pending.length;

  const addPhotos = async (from: 'camera' | 'library') => {
    setNotice(null);
    try {
      const room = LISTING_MAX_IMAGES - photoCount;
      const picked =
        from === 'camera'
          ? [await media.takePhoto()].filter((p): p is PickedImage => !!p)
          : await media.pickPhotos(room);
      const photos = picked.slice(0, room);
      if (!editing) {
        setPending((p) => [...p, ...photos]);
        return;
      }
      // Editing: pictures are added to the listing at once.
      for (const photo of photos) {
        const { path } = await services.marketplace.uploadImage({
          communityId: community.community_id,
          file: photo.bytes,
          mimeType: photo.mimeType,
        });
        const image = await services.marketplace.addImage(l.id, {
          path,
          width: photo.width ?? 1080,
          height: photo.height ?? 1080,
        });
        setExisting((e) => [...e, image]);
      }
    } catch (thrown) {
      setNotice(thrown instanceof CameraUnavailableError ? thrown.message : marketError(thrown));
    }
  };

  const removeExisting = async (image: ListingImage) => {
    setNotice(null);
    try {
      await services.marketplace.removeImage(image.id);
      setExisting((e) => e.filter((i) => i.id !== image.id));
    } catch (thrown) {
      setNotice(marketError(thrown));
    }
  };

  const validate = () => {
    const found: Record<string, string> = {};
    if (title.trim().length < 3) found.title = 'Give it a title of at least 3 characters.';
    if (!categories.some((c) => c.id === categoryId && c.kind === kind))
      found.category = 'Choose a category.';
    const price = parsePrice(priceText);
    if (pricing !== 'quote') {
      if ('error' in price) found.price = price.error;
      else if (price.minor === null) found.price = 'Enter a price.';
    }
    if (kind === 'product' && !pickup && !delivery) found.fulfillment = 'Offer pickup, delivery or both.';
    if (kind === 'product' && !/^\d{1,7}$/.test(stockText.trim()))
      found.stock = 'Enter how many you have (0 or more).';
    setErrors(found);
    return Object.keys(found).length === 0
      ? pricing === 'quote'
        ? null
        : (price as { minor: number }).minor
      : undefined;
  };

  const save = async (publish: boolean) => {
    const priceMinor = validate();
    if (priceMinor === undefined) return;
    setSaving(true);
    setNotice(null);
    const fields = {
      categoryId,
      title: title.trim(),
      description: description.trim(),
      pricing: kind === 'product' ? ('fixed' as const) : pricing,
      priceMinor,
      ...(kind === 'product'
        ? {
            condition,
            fulfillment: [
              ...(pickup ? ['pickup' as const] : []),
              ...(delivery ? ['seller_delivery' as const] : []),
            ],
            pickupArea: area.trim() || null,
          }
        : { serviceArea: area.trim() || null }),
    };
    const m = services.marketplace;
    try {
      if (editing) {
        await m.updateListing(l.id, fields);
        if (kind === 'product' && Number(stockText) !== detail?.stock?.onHand)
          await m.setStock(l.id, Number(stockText));
        onDone(l.id, false);
        return;
      }
      const created = await m.createListing({
        communityId: community.community_id,
        kind,
        ...fields,
        publish,
      });
      let failed = 0;
      for (const photo of pending) {
        try {
          const { path } = await m.uploadImage({
            communityId: community.community_id,
            file: photo.bytes,
            mimeType: photo.mimeType,
          });
          await m.addImage(created.id, { path, width: photo.width ?? 1080, height: photo.height ?? 1080 });
        } catch {
          failed += 1;
        }
      }
      if (kind === 'product') await m.setStock(created.id, Number(stockText));
      onDone(
        created.id,
        true,
        failed
          ? `Saved, but ${failed} picture${failed === 1 ? '' : 's'} could not be uploaded. Edit the listing to add ${failed === 1 ? 'it' : 'them'} again.`
          : undefined,
      );
    } catch (thrown) {
      setNotice(marketError(thrown));
      setSaving(false);
    }
  };

  const kindCategories = categories.filter((c) => c.kind === kind);
  return (
    <Screen testID="listing-editor-screen">
      {notice ? <Banner tone="danger" message={notice} testID="listing-editor-error" /> : null}
      {!editing ? (
        <ChipRow
          options={[
            { value: 'product', label: 'Product' },
            { value: 'service', label: 'Service' },
          ]}
          value={kind}
          onChange={(k: ListingKind) => {
            setKind(k);
            setCategoryId('');
            if (k === 'product') setPricing('fixed');
          }}
          label="What are you listing?"
        />
      ) : null}

      <View style={styles.section}>
        <Text variant="label">
          Photos ({photoCount}/{LISTING_MAX_IMAGES})
        </Text>
        <View style={styles.photos}>
          {existing.map((image) => (
            <View key={image.id} style={styles.photo}>
              {image.url ? <Image source={{ uri: image.url }} style={styles.photoImage} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove picture"
                onPress={() => void removeExisting(image)}
                style={styles.photoRemove}
              >
                <Icon name="close" size={16} color="onPrimary" />
              </Pressable>
            </View>
          ))}
          {pending.map((photo, i) => (
            <View key={photo.uri + i} style={styles.photo} testID="pending-photo">
              <Image source={{ uri: photo.uri }} style={styles.photoImage} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove picture"
                onPress={() => setPending((p) => p.filter((_, j) => j !== i))}
                style={styles.photoRemove}
              >
                <Icon name="close" size={16} color="onPrimary" />
              </Pressable>
            </View>
          ))}
        </View>
        {photoCount < LISTING_MAX_IMAGES ? (
          <View style={styles.row}>
            <Button
              title="Add photos"
              icon="images-outline"
              variant="secondary"
              fullWidth={false}
              onPress={() => void addPhotos('library')}
            />
            <Button
              title="Take photo"
              icon="camera-outline"
              variant="ghost"
              fullWidth={false}
              onPress={() => void addPhotos('camera')}
            />
          </View>
        ) : null}
      </View>

      <TextField label="Title" value={title} onChangeText={setTitle} maxLength={120} error={errors.title} />
      <View style={styles.section}>
        <Text variant="label">Category</Text>
        <ChipRow
          options={kindCategories.map((c) => ({ value: c.id, label: c.name }))}
          value={categoryId}
          onChange={setCategoryId}
          label="Category"
        />
        {errors.category ? (
          <Text tone="danger" variant="caption">
            {errors.category}
          </Text>
        ) : null}
      </View>

      {kind === 'service' ? (
        <ChipRow<Pricing>
          options={[
            { value: 'fixed', label: 'Fixed price' },
            { value: 'hourly', label: 'Per hour' },
            { value: 'quote', label: 'Price on request' },
          ]}
          value={pricing}
          onChange={setPricing}
          label="Pricing"
        />
      ) : null}
      {pricing !== 'quote' ? (
        <TextField
          label={pricing === 'hourly' ? 'Price per hour (J$)' : 'Price (J$)'}
          value={priceText}
          onChangeText={setPriceText}
          keyboardType="decimal-pad"
          error={errors.price}
        />
      ) : null}

      {kind === 'product' ? (
        <>
          <View style={styles.section}>
            <Text variant="label">Condition</Text>
            <ChipRow<Condition>
              options={(Object.keys(CONDITION_LABELS) as Condition[]).map((c) => ({
                value: c,
                label: CONDITION_LABELS[c]!,
              }))}
              value={condition}
              onChange={setCondition}
              label="Condition"
            />
          </View>
          <TextField
            label="How many do you have?"
            value={stockText}
            onChangeText={setStockText}
            keyboardType="number-pad"
            error={errors.stock}
          />
          <View style={styles.section}>
            <Text variant="label">How buyers get it</Text>
            {(
              [
                ['pickup', pickup, setPickup],
                ['seller_delivery', delivery, setDelivery],
              ] as const
            ).map(([key, value, set]) => (
              <View key={key} style={styles.switchRow}>
                <Text style={styles.flex}>{FULFILLMENT_LABELS[key]}</Text>
                <Switch
                  value={value}
                  onValueChange={set}
                  accessibilityLabel={FULFILLMENT_LABELS[key]}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>
            ))}
            {errors.fulfillment ? (
              <Text tone="danger" variant="caption">
                {errors.fulfillment}
              </Text>
            ) : null}
          </View>
        </>
      ) : null}

      <TextField
        label={kind === 'product' ? 'Pickup area (optional)' : 'Where you work (optional)'}
        value={area}
        onChangeText={setArea}
        maxLength={kind === 'product' ? 120 : 200}
        hint={kind === 'product' ? 'A neighbourhood, not your full address.' : 'Areas or parishes you serve.'}
      />
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        maxLength={5000}
        multiline
      />

      {editing ? (
        <Button title="Save changes" loading={saving} onPress={() => void save(false)} />
      ) : (
        <>
          <Button title="Publish" loading={saving} onPress={() => void save(true)} />
          <Button title="Save as draft" variant="ghost" disabled={saving} onPress={() => void save(false)} />
        </>
      )}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  section: { gap: t.spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  photo: {
    width: 84,
    height: 84,
    borderRadius: t.radius.md,
    overflow: 'hidden',
    backgroundColor: t.colors.surfaceMuted,
  },
  photoImage: { width: '100%', height: '100%' },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.scrim,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
}));

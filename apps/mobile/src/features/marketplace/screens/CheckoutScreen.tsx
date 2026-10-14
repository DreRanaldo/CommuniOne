import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Address, CheckoutPreview, Fulfillment } from '@communione/services';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
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
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { ChipRow } from '../components/ChipRow';
import { FULFILLMENT_LABELS, formatMoney } from '../marketRules';
import { estimateText, orderError, problemText } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Checkout'>;

/**
 * Checkout (Stage D): pickup or delivery per seller, a delivery address,
 * contact details, and the server's totals. "Place order" sends the total
 * the buyer saw; the server re-prices and refuses any other total. Nothing
 * is paid here: the next screen pays through the payment provider.
 */
export function CheckoutScreen({ navigation }: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const { orders } = useServices();
  const [picked, setPicked] = useState<Record<string, Fulfillment>>({});
  const [pickedAddress, setPickedAddress] = useState<string | null>(null);
  const [typedName, setContactName] = useState<string | null>(null);
  const [typedPhone, setContactPhone] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per checkout attempt: a retried tap never creates a second order.
  const [requestId, setRequestId] = useState(() => orders.newRequestId());

  const loadAddresses = useCallback(() => orders.addresses(), [orders]);
  const addresses = useAsync(loadAddresses);
  const reloadAddresses = addresses.reload;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else reloadAddresses();
    }, [reloadAddresses]),
  );

  // Defaults come from the address book until the buyer changes them.
  const book: Address[] = useMemo(() => (addresses.status === 'success' ? addresses.data : []), [addresses]);
  const preferred = book.find((a) => a.is_default) ?? book[0] ?? null;
  const addressId =
    pickedAddress && book.some((a) => a.id === pickedAddress) ? pickedAddress : (preferred?.id ?? null);
  const contactName = typedName ?? preferred?.recipient_name ?? '';
  const contactPhone = typedPhone ?? preferred?.phone ?? '';

  // The server's totals for the current choices. The last totals stay on
  // screen while new choices are re-priced.
  const [priced, setPriced] = useState<{ key: string; data: CheckoutPreview | null; error: unknown }>({
    key: '',
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  // Sellers whose items allow only one method get it chosen for them.
  const choices = useMemo(() => {
    const auto: Record<string, Fulfillment> = {};
    for (const s of priced.data?.sellers ?? [])
      if (s.methods.length === 1) auto[s.sellerProfileId] = s.methods[0]!;
    return { ...auto, ...picked };
  }, [priced.data, picked]);
  const choiceList = useMemo(
    () => Object.entries(choices).map(([sellerProfileId, method]) => ({ sellerProfileId, method })),
    [choices],
  );
  const needsAddress = choiceList.some((c) => c.method === 'seller_delivery');
  const previewAddress = needsAddress ? addressId : null;
  const key = JSON.stringify([choiceList, previewAddress, attempt]);
  useEffect(() => {
    let current = true;
    // Everything the request depends on is in `key` (choices, address, retry).
    const [list, address] = JSON.parse(key) as [typeof choiceList, string | null];
    orders.preview(community.community_id, list, address).then(
      (data) => current && setPriced({ key, data, error: null }),
      (thrown: unknown) => current && setPriced((p) => ({ key, data: p.data, error: thrown })),
    );
    return () => {
      current = false;
    };
  }, [orders, community.community_id, key]);
  const repricing = priced.key !== key;
  const preview = {
    status: priced.error && !repricing ? ('error' as const) : ('ready' as const),
    error: priced.error,
    reload: () => setAttempt((a) => a + 1),
  };
  const setChoices = (update: (c: Record<string, Fulfillment>) => Record<string, Fulfillment>) =>
    setPicked(update);
  const setAddressId = setPickedAddress;

  if (preview.status === 'error')
    return (
      <ErrorState
        title="Checkout could not be loaded"
        message={orderError(preview.error)}
        onRetry={preview.reload}
      />
    );
  const p = priced.data;
  if (!p) return <LoadingState label="Working out your total…" />;
  if (p.sellers.length === 0)
    return (
      <EmptyState
        icon="cart-outline"
        title="Your cart is empty"
        message="Add something from the marketplace first."
        action={{ title: 'Browse the marketplace', onPress: () => navigation.navigate('Market') }}
      />
    );

  const problems = [...new Set(p.problems.map((x) => x.problem))];
  const ready = problems.length === 0 && contactName.trim() !== '' && contactPhone.trim() !== '';

  const place = async () => {
    setPlacing(true);
    setError(null);
    try {
      const checkoutId = await orders.create({
        communityId: community.community_id,
        clientRequestId: requestId,
        choices: choiceList,
        addressId: needsAddress ? addressId : null,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        expectedTotalMinor: p.totalMinor,
      });
      navigation.replace('Payment', { checkoutId });
    } catch (thrown) {
      setError(orderError(thrown));
      setRequestId(orders.newRequestId());
      preview.reload();
    } finally {
      setPlacing(false);
    }
  };

  return (
    <Screen testID="checkout-screen">
      {error ? <Banner tone="danger" message={error} testID="checkout-error" /> : null}
      {p.sellers.map((s) => (
        <Card key={s.sellerProfileId} testID={`checkout-seller-${s.sellerProfileId}`}>
          <View style={styles.row}>
            <Icon name="storefront-outline" size={18} color="primary" />
            <Text variant="label" style={styles.flex}>
              {s.sellerName}
            </Text>
            <Text variant="bodyStrong">{formatMoney(s.subtotalMinor, p.currency)}</Text>
          </View>
          {s.lines.map((l) => (
            <Text key={l.listingId} tone="muted">{`${l.quantity} × ${l.title}`}</Text>
          ))}
          {s.methods.length > 0 ? (
            <ChipRow<Fulfillment>
              label={`How to get your items from ${s.sellerName}`}
              options={s.methods.map((m) => ({ value: m, label: FULFILLMENT_LABELS[m] ?? m }))}
              value={choices[s.sellerProfileId] ?? ('' as Fulfillment)}
              onChange={(m) => setChoices((c) => ({ ...c, [s.sellerProfileId]: m }))}
              testID={`checkout-method-${s.sellerProfileId}`}
            />
          ) : (
            <Text tone="danger" variant="caption">
              These items have no pickup or delivery option in common. Buy them separately.
            </Text>
          )}
          {s.method === 'seller_delivery' ? (
            <Text variant="caption" tone="muted">
              {s.deliveryAvailable
                ? `Delivery ${formatMoney(s.deliveryMinor, p.currency)}${estimateText(s.estimatedDays) ? ` · usually ${estimateText(s.estimatedDays)}` : ''}`
                : 'This seller does not deliver to the chosen address.'}
            </Text>
          ) : null}
          {s.method === 'pickup' ? (
            <Text variant="caption" tone="muted">
              The seller will tell you where and when to collect after accepting the order.
            </Text>
          ) : null}
        </Card>
      ))}

      {needsAddress ? (
        <Card testID="checkout-addresses">
          <Text variant="label">Deliver to</Text>
          {book.map((a) => {
            const selected = a.id === addressId;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={`${a.recipient_name}, ${a.line1}, ${a.town}, ${a.parish}`}
                onPress={() => setAddressId(a.id)}
                style={[styles.address, selected && styles.addressSelected]}
                testID={`checkout-address-${a.id}`}
              >
                <Icon
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={selected ? 'primary' : 'textMuted'}
                />
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{a.label ?? a.recipient_name}</Text>
                  <Text
                    tone="muted"
                    variant="caption"
                  >{`${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.town}, ${a.parish}`}</Text>
                </View>
              </Pressable>
            );
          })}
          <Button
            title={book.length === 0 ? 'Add a delivery address' : 'Add another address'}
            variant="secondary"
            icon="add"
            onPress={() => navigation.navigate('AddressEditor')}
            testID="checkout-add-address"
          />
        </Card>
      ) : null}

      <Card>
        <Text variant="label">Contact for this order</Text>
        <Text variant="caption" tone="muted">
          Shared only with the sellers of this order, to arrange pickup or delivery.
        </Text>
        <TextField
          label="Name"
          value={contactName}
          onChangeText={setContactName}
          autoComplete="name"
          testID="checkout-contact-name"
        />
        <TextField
          label="Phone"
          value={contactPhone}
          onChangeText={setContactPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
          testID="checkout-contact-phone"
        />
      </Card>

      <Card testID="checkout-summary">
        <SummaryRow label="Items" value={formatMoney(p.subtotalMinor, p.currency)} />
        <SummaryRow label="Delivery" value={formatMoney(p.deliveryMinor, p.currency)} />
        {p.taxMinor > 0 ? <SummaryRow label="GCT" value={formatMoney(p.taxMinor, p.currency)} /> : null}
        {p.discountMinor > 0 ? (
          <SummaryRow label="Discount" value={`-${formatMoney(p.discountMinor, p.currency)}`} />
        ) : null}
        <SummaryRow
          label="Total"
          value={formatMoney(p.totalMinor, p.currency)}
          strong
          testID="checkout-total"
        />
        {problems.map((x) => (
          <Text key={x} tone="danger" variant="caption" testID={`checkout-problem-${x}`}>
            {problemText(x)}
          </Text>
        ))}
        <Text variant="caption" tone="muted">
          Your items are held for 20 minutes while you pay. Each seller confirms their part of the order after
          payment.
        </Text>
        <Button
          title={`Place order · ${formatMoney(p.totalMinor, p.currency)}`}
          disabled={!ready || repricing}
          loading={placing}
          onPress={() => void place()}
          testID="checkout-place"
        />
      </Card>
    </Screen>
  );
}

function SummaryRow({
  label,
  value,
  strong,
  testID,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text variant={strong ? 'heading' : 'body'} style={styles.flex}>
        {label}
      </Text>
      <Text variant={strong ? 'heading' : 'body'} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  flex: { flex: 1, gap: 2 },
  address: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    padding: t.spacing.sm,
    borderRadius: t.radius.sm,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  addressSelected: { borderColor: t.colors.primary },
}));

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PARISHES, type DeliveryOption, type Parish } from '@communione/services';
import { useCallback, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { formatMoney, parsePrice, priceInput } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'DeliverySettings'>;

/**
 * A seller's own delivery offer (Stage D): one flat fee, the parishes
 * served (none chosen = all), and an optional estimate shown to buyers.
 * The server applies the fee at checkout; buyers cannot change it.
 */
export function DeliverySettingsScreen({ navigation, route }: Props) {
  const { orders } = useServices();
  const { sellerProfileId } = route.params;
  const load = useCallback(() => orders.deliveryOption(sellerProfileId), [orders, sellerProfileId]);
  const current = useAsync(load);
  if (current.status === 'loading') return <LoadingState />;
  if (current.status === 'error')
    return <ErrorState message={orderError(current.error)} onRetry={current.reload} />;
  return (
    <DeliveryForm
      initial={current.data}
      sellerProfileId={sellerProfileId}
      onSaved={() => navigation.goBack()}
    />
  );
}

function DeliveryForm({
  initial: d,
  sellerProfileId,
  onSaved,
}: {
  initial: DeliveryOption | null;
  sellerProfileId: string;
  onSaved(): void;
}) {
  const styles = useStyles();
  const community = useCommunity();
  const { orders } = useServices();
  const [active, setActive] = useState(d?.active ?? false);
  const [fee, setFee] = useState(d ? priceInput(Number(d.fee_minor)) : '');
  const [parishes, setParishes] = useState<Parish[]>((d?.parishes as Parish[] | undefined) ?? []);
  const [minDays, setMinDays] = useState(d?.estimated_days_min == null ? '' : String(d.estimated_days_min));
  const [maxDays, setMaxDays] = useState(d?.estimated_days_max == null ? '' : String(d.estimated_days_max));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const parsed = parsePrice(fee || '0');
    if ('error' in parsed) return setError(parsed.error);
    const days = (text: string) => (text.trim() === '' ? null : Number(text));
    const min = days(minDays);
    const max = days(maxDays);
    if ([min, max].some((n) => n !== null && (!Number.isInteger(n) || n < 0 || n > 60)))
      return setError('Days must be whole numbers from 0 to 60.');
    if (min !== null && max !== null && min > max)
      return setError('The shortest estimate must not be longer than the longest.');
    setSaving(true);
    try {
      await orders.saveDeliveryOption({
        sellerProfileId,
        communityId: community.community_id,
        feeMinor: parsed.minor ?? 0,
        parishes,
        estimatedDaysMin: min,
        estimatedDaysMax: max,
        active,
      });
      onSaved();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (p: Parish) =>
    setParishes((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
  const parsedFee = parsePrice(fee || '0');

  return (
    <Screen testID="delivery-settings">
      {error ? <Banner tone="danger" message={error} testID="delivery-error" /> : null}
      <View style={styles.row}>
        <Text style={styles.flex}>I deliver orders myself</Text>
        <Switch
          value={active}
          onValueChange={setActive}
          accessibilityLabel="I deliver orders myself"
          testID="delivery-active"
        />
      </View>
      <TextField
        label="Delivery fee (J$)"
        value={fee}
        onChangeText={setFee}
        keyboardType="decimal-pad"
        hint={'minor' in parsedFee ? `Buyers pay ${formatMoney(parsedFee.minor ?? 0)} per order` : undefined}
        testID="delivery-fee"
      />
      <Text variant="label">Parishes you deliver to</Text>
      <Text variant="caption" tone="muted">
        {parishes.length === 0
          ? 'All parishes (choose some to limit delivery).'
          : `${parishes.length} selected`}
      </Text>
      <View style={styles.wrap}>
        {PARISHES.map((p) => {
          const on = parishes.includes(p);
          return (
            <Pressable
              key={p}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => toggle(p)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text variant="caption" tone={on ? 'inverse' : undefined}>
                {p}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.row}>
        <View style={styles.flex}>
          <TextField
            label="Usually from (days)"
            value={minDays}
            onChangeText={setMinDays}
            keyboardType="number-pad"
          />
        </View>
        <View style={styles.flex}>
          <TextField label="To (days)" value={maxDays} onChangeText={setMaxDays} keyboardType="number-pad" />
        </View>
      </View>
      <Text variant="caption" tone="muted">
        Estimates are shown to buyers as a guide only, never as a promise.
      </Text>
      <Button
        title="Save delivery settings"
        loading={saving}
        onPress={() => void save()}
        testID="delivery-save"
      />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs },
  chip: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  chipOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
}));

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { SlotPicker } from '../components/SlotPicker';
import { marketError, priceLabel } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'BookService'>;

/**
 * Request a booking for a service (Stage J). The seller accepts (fixing the
 * price), proposes another time, or declines; nothing is paid until then.
 */
export function BookServiceScreen({ navigation, route }: Props) {
  const { marketplace, bookings } = useServices();
  const { listingId } = route.params;
  const load = useCallback(() => marketplace.listing(listingId), [marketplace, listingId]);
  const listing = useAsync(load);
  const [slot, setSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [note, setNote] = useState('');
  const [place, setPlace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (listing.status === 'loading') return <LoadingState />;
  if (listing.status === 'error')
    return <ErrorState message={marketError(listing.error)} onRetry={listing.reload} />;
  const l = listing.data.listing;

  const submit = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const bookingId = await bookings.request({
        listingId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        note: note || null,
        locationNote: place || null,
      });
      navigation.replace('BookingDetail', { bookingId });
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="book-service">
      {error ? <Banner tone="danger" message={error} testID="book-error" /> : null}
      <Card>
        <Text variant="heading">{l.title}</Text>
        <Text tone="muted">
          {priceLabel({ pricing: l.pricing, priceMinor: l.price_minor, currency: l.currency })}
        </Text>
      </Card>
      <SlotPicker sellerProfileId={l.seller_profile_id} onChange={setSlot} />
      <TextField
        label="Where (optional)"
        placeholder="Address or area"
        value={place}
        onChangeText={setPlace}
        testID="book-place"
      />
      <TextField
        label="Details for the seller (optional)"
        value={note}
        onChangeText={setNote}
        multiline
        testID="book-note"
      />
      <Text variant="caption" tone="muted">
        You pay only after the seller accepts. The final price is set by the server from the listing (or by
        the seller for quoted services).
      </Text>
      <Button
        title="Request booking"
        disabled={!slot}
        loading={busy}
        onPress={() => void submit()}
        testID="book-submit"
      />
    </Screen>
  );
}

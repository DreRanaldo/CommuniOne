import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BOOKING_STATUS_LABELS, type Booking, type BookingEvent } from '@communione/services';
import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { formatLocal } from '../bookingRules';
import { SlotPicker } from '../components/SlotPicker';
import { formatMoney, parsePrice } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'BookingDetail'>;
type Form = null | 'accept' | 'propose' | 'decline' | 'cancel';

/**
 * One booking for its buyer or seller. Steps are offered from the server's
 * status and checked again by the server.
 */
export function BookingDetailScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { bookings } = useServices();
  const { bookingId } = route.params;
  const [state, setState] = useState<{
    data: { booking: Booking; events: BookingEvent[]; role: 'buyer' | 'seller' } | null;
    error: unknown;
  }>({
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      bookings.booking(bookingId).then(
        (data) => current && setState({ data, error: null }),
        (error: unknown) => current && setState((s) => ({ data: s.data, error })),
      );
      return () => {
        current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` deliberately forces a reload
    }, [bookings, bookingId, attempt]),
  );
  const [form, setForm] = useState<Form>(null);
  const [text, setText] = useState('');
  const [slot, setSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.error && !state.data) return <ErrorState message={orderError(state.error)} onRetry={reload} />;
  if (!state.data) return <LoadingState />;
  const { booking: b, events, role } = state.data;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setForm(null);
      setText('');
      reload();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };
  const btn = (
    key: string,
    title: string,
    onPress: () => void,
    variant: 'primary' | 'secondary' | 'ghost' = 'primary',
  ) => (
    <Button
      key={key}
      title={title}
      variant={variant}
      disabled={busy}
      onPress={onPress}
      testID={`booking-${key}`}
    />
  );

  const buttons: ReactNode[] = [];
  if (role === 'seller') {
    if (b.status === 'requested')
      buttons.push(
        btn('accept', 'Accept', () =>
          b.pricing_snapshot === 'quote' ? setForm('accept') : void run(() => bookings.accept(b.id)),
        ),
      );
    if (['requested', 'proposed'].includes(b.status)) {
      buttons.push(btn('propose', 'Propose another time', () => setForm('propose'), 'secondary'));
      buttons.push(btn('decline', 'Decline', () => setForm('decline'), 'ghost'));
    }
    // The server refuses before the start time.
    if (b.status === 'confirmed')
      buttons.push(btn('complete', 'Mark done', () => void run(() => bookings.complete(b.id))));
  } else {
    if (b.status === 'proposed')
      buttons.push(btn('agree', 'Accept the new time', () => void run(() => bookings.acceptProposal(b.id))));
    if (b.status === 'accepted')
      buttons.push(
        btn('pay', `Pay ${formatMoney(Number(b.amount_minor), b.currency)}`, () =>
          navigation.navigate('Payment', { bookingId: b.id }),
        ),
      );
    if (['confirmed', 'completed'].includes(b.status))
      buttons.push(
        btn(
          'dispute',
          'Report a problem',
          () => navigation.navigate('Dispute', { bookingId: b.id }),
          'ghost',
        ),
      );
  }
  if (['requested', 'proposed', 'accepted', 'confirmed'].includes(b.status))
    buttons.push(btn('cancel', 'Cancel booking', () => setForm('cancel'), 'ghost'));

  let formView: ReactNode = null;
  if (form === 'accept') {
    formView = (
      <>
        <TextField
          label="Your price (J$)"
          value={text}
          onChangeText={setText}
          keyboardType="decimal-pad"
          testID="booking-form-text"
        />
        <Button
          title="Accept at this price"
          loading={busy}
          onPress={() => {
            const parsed = parsePrice(text);
            if ('error' in parsed || !parsed.minor) return setError('Enter the price for this booking.');
            void run(() => bookings.accept(b.id, parsed.minor));
          }}
          testID="booking-form-submit"
        />
      </>
    );
  } else if (form === 'propose') {
    formView = (
      <>
        <SlotPicker sellerProfileId={b.seller_profile_id} onChange={setSlot} />
        <TextField label="Note (optional)" value={text} onChangeText={setText} testID="booking-form-text" />
        <Button
          title="Propose"
          disabled={!slot}
          loading={busy}
          onPress={() =>
            slot && void run(() => bookings.propose(b.id, slot.startsAt, slot.endsAt, text || null))
          }
          testID="booking-form-submit"
        />
      </>
    );
  } else if (form === 'decline' || form === 'cancel') {
    formView = (
      <>
        <TextField label="Reason" value={text} onChangeText={setText} multiline testID="booking-form-text" />
        {form === 'cancel' && b.status === 'confirmed' ? (
          <Text variant="caption" tone="muted">
            The buyer is refunded in full. The refund completes once the payment provider processes it.
          </Text>
        ) : null}
        <Button
          title={form === 'decline' ? 'Decline booking' : 'Cancel booking'}
          loading={busy}
          onPress={() =>
            void run(() => (form === 'decline' ? bookings.decline(b.id, text) : bookings.cancel(b.id, text)))
          }
          testID="booking-form-submit"
        />
      </>
    );
  }

  return (
    <Screen testID="booking-detail">
      {error ? <Banner tone="danger" message={error} testID="booking-error" /> : null}
      <Card>
        <Text variant="heading">{b.title_snapshot}</Text>
        <Text testID="booking-status">{BOOKING_STATUS_LABELS[b.status] ?? b.status}</Text>
        <Text
          tone="muted"
          testID="booking-time"
        >{`${formatLocal(b.startsAt)} – ${formatLocal(b.endsAt).split(', ')[1]} (Jamaica time)`}</Text>
        {b.amount_minor ? (
          <Text variant="bodyStrong" testID="booking-amount">
            {formatMoney(Number(b.amount_minor), b.currency)}
          </Text>
        ) : null}
        {b.location_note ? <Text>{`Where: ${b.location_note}`}</Text> : null}
        {b.buyer_note ? <Text tone="muted">{b.buyer_note}</Text> : null}
        {b.status_reason ? (
          <Text tone="muted" variant="caption">
            {b.status_reason}
          </Text>
        ) : null}
      </Card>
      {buttons.length || formView ? (
        <Card testID="booking-actions">
          {formView ?? buttons}
          {formView ? <Button title="Back" variant="ghost" onPress={() => setForm(null)} /> : null}
        </Card>
      ) : null}
      <Card>
        <Text variant="label">History</Text>
        {events.map((e) => (
          <View key={e.id} style={styles.row}>
            <Text style={styles.flex}>{BOOKING_STATUS_LABELS[e.to_status] ?? e.to_status}</Text>
            <Text variant="caption" tone="muted">
              {new Date(e.created_at).toLocaleDateString()}
            </Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

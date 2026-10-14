import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CheckoutPaymentState } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useDependencies } from '@/lib/dependencies';
import { PAYMENT_RETURN_URL } from '@/lib/paymentBrowser';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { formatMoney } from '../marketRules';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Payment'>;

/** Delays between status checks after returning from the payment page. */
export const PAYMENT_POLL_DELAYS_MS = [0, 1000, 2000, 3000, 5000];
const BOOKING_AS_CHECKOUT: Record<string, string> = {
  accepted: 'awaiting_payment',
  confirmed: 'paid',
  completed: 'paid',
  declined: 'cancelled',
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paying for a checkout (Stage E). The amount and the result are the
 * server's: the app opens the provider's hosted page, then asks the server
 * what the provider confirmed (signed webhook or reconciliation). Coming
 * back from the page is never treated as payment.
 */
export function PaymentScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { services, paymentBrowser } = useDependencies();
  const { checkoutId, bookingId } = route.params;
  // A checkout (products) or a booking (services); bookings are shown in the same terms.
  const fetchState = useCallback(
    (): Promise<CheckoutPaymentState> =>
      checkoutId
        ? services.payments.state(checkoutId)
        : services.payments.bookingState(bookingId!).then((b) => ({
            checkoutStatus: BOOKING_AS_CHECKOUT[b.status] ?? b.status,
            totalMinor: b.amountMinor ?? 0,
            currency: b.currency,
            reservationExpiresAt: b.paymentDueAt ?? new Date(0).toISOString(),
            payment: b.payment,
            paid: b.paid,
          })),
    [services, checkoutId, bookingId],
  );
  const load = fetchState;
  const state = useAsync(load);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'checking' | 'waiting'>('idle');
  const [notice, setNotice] = useState<{ tone: 'danger' | 'info'; message: string } | null>(null);
  const [testMode, setTestMode] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const check = async () => {
    setPhase('checking');
    for (const delay of PAYMENT_POLL_DELAYS_MS) {
      if (delay) await wait(delay);
      if (!mounted.current) return;
      try {
        const s = await fetchState();
        if (
          s.paid ||
          ['failed', 'cancelled', 'expired'].includes(s.payment?.status ?? '') ||
          s.payment?.failureCode === 'amount_mismatch'
        ) {
          if (!s.paid && s.payment?.failureCode === 'amount_mismatch')
            setNotice({
              tone: 'danger',
              message: 'The payment needs to be checked by our team. You will be notified; do not pay again.',
            });
          else if (!s.paid)
            setNotice({
              tone: 'danger',
              message: 'The payment was not completed. You can try again while your items are reserved.',
            });
          break;
        }
      } catch {
        // keep checking
      }
    }
    if (!mounted.current) return;
    setPhase('idle');
    state.reload();
  };

  const pay = async () => {
    setPhase('starting');
    setNotice(null);
    try {
      const session = checkoutId
        ? await services.payments.start(checkoutId)
        : await services.payments.startBooking(bookingId!);
      setTestMode(session.mode === 'test');
      setPhase('waiting');
      await paymentBrowser.open(session.redirectUrl, PAYMENT_RETURN_URL);
      await check();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: orderError(thrown) });
      setPhase('idle');
      state.reload();
    }
  };

  const cancel = async () => {
    setPhase('starting');
    try {
      if (checkoutId) {
        await services.orders.cancelCheckout(checkoutId);
        navigation.navigate('Orders');
      } else navigation.navigate('BookingDetail', { bookingId: bookingId! });
    } catch (thrown) {
      setNotice({ tone: 'danger', message: orderError(thrown) });
      setPhase('idle');
      state.reload();
    }
  };

  if (state.status === 'loading' && phase === 'idle') return <LoadingState label="Loading your order…" />;
  if (state.status === 'error')
    return (
      <ErrorState
        title="This order could not be loaded"
        message={orderError(state.error)}
        onRetry={state.reload}
      />
    );
  if (phase === 'checking' || phase === 'waiting' || !state.data)
    return <LoadingState label="Checking your payment with the provider…" />;
  const s = state.data;
  // The server refuses to start a payment once the reservation has ended.
  const payable = ['awaiting_payment', 'payment_failed'].includes(s.checkoutStatus);
  const pendingConfirmation =
    !s.paid &&
    ['pending', 'requires_action', 'unknown'].includes(s.payment?.status ?? '') &&
    s.payment?.failureCode !== 'amount_mismatch';
  const heldUntil = new Date(s.reservationExpiresAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <Screen testID="payment-screen">
      {testMode || s.payment?.mode === 'test' ? (
        <Banner
          title="Test mode"
          message="Payments are in test mode: no real money is charged."
          testID="payment-test-mode"
        />
      ) : null}
      {notice ? <Banner tone={notice.tone} message={notice.message} testID="payment-notice" /> : null}
      <Card>
        <View style={styles.row}>
          <Icon
            name={s.paid ? 'checkmark-circle' : 'card-outline'}
            size={28}
            color={s.paid ? 'success' : 'primary'}
          />
          <View style={styles.flex}>
            <Text variant="heading" testID="payment-status">
              {s.paid
                ? 'Payment confirmed'
                : s.checkoutStatus === 'expired'
                  ? 'Reservation ended'
                  : s.checkoutStatus === 'cancelled'
                    ? 'Order cancelled'
                    : 'Payment needed'}
            </Text>
            <Text tone="muted">{`Total ${formatMoney(s.totalMinor, s.currency)}`}</Text>
          </View>
        </View>
        {s.paid ? (
          <Text>
            Each seller has been asked to accept your order. You will be notified as it moves along.
          </Text>
        ) : pendingConfirmation ? (
          <Text testID="payment-pending">
            We are waiting for the payment provider to confirm. This can take a few minutes; you will be
            notified.
          </Text>
        ) : payable ? (
          <Text tone="muted">
            {checkoutId
              ? `Your items are held until ${heldUntil}.`
              : `Pay by ${heldUntil} to keep this booking.`}
          </Text>
        ) : s.checkoutStatus === 'expired' ? (
          <Text tone="muted">
            Your items were not paid for in time and have been released. Add them to your cart again to buy
            them.
          </Text>
        ) : null}
      </Card>
      {payable && !pendingConfirmation ? (
        <Button
          title={`Pay ${formatMoney(s.totalMinor, s.currency)}`}
          icon="lock-closed-outline"
          loading={phase === 'starting'}
          onPress={() => void pay()}
          testID="payment-pay"
        />
      ) : null}
      {pendingConfirmation ? (
        <Button title="Check again" variant="secondary" onPress={() => void check()} testID="payment-check" />
      ) : null}
      {payable && !pendingConfirmation ? (
        <Button
          title={checkoutId ? 'Cancel order' : 'Not now'}
          variant="ghost"
          disabled={phase !== 'idle'}
          onPress={() => void cancel()}
          testID="payment-cancel"
        />
      ) : null}
      {s.paid || !payable ? (
        <Button
          title={checkoutId ? 'View your orders' : 'View booking'}
          variant={s.paid ? 'primary' : 'secondary'}
          onPress={() =>
            checkoutId
              ? navigation.navigate('Orders')
              : navigation.navigate('BookingDetail', { bookingId: bookingId! })
          }
          testID="payment-orders"
        />
      ) : null}
      <Text variant="caption" tone="muted">
        Card details are entered on the payment provider&apos;s secure page. CommuniOne never sees or stores
        them.
      </Text>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  flex: { flex: 1, gap: 2 },
}));

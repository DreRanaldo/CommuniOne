import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AvailabilityWindow } from '@communione/services';
import { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'ServiceHours'>;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A seller's weekly hours for bookings (Jamaica time). No hours set: any time. */
export function ServiceHoursScreen({ navigation, route }: Props) {
  const { bookings } = useServices();
  const { sellerProfileId } = route.params;
  const load = useCallback(() => bookings.availability(sellerProfileId), [bookings, sellerProfileId]);
  const data = useAsync(load);
  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <ErrorState message={orderError(data.error)} onRetry={data.reload} />;
  return (
    <HoursForm initial={data.data} sellerProfileId={sellerProfileId} onSaved={() => navigation.goBack()} />
  );
}

function HoursForm({
  initial,
  sellerProfileId,
  onSaved,
}: {
  initial: AvailabilityWindow[];
  sellerProfileId: string;
  onSaved(): void;
}) {
  const styles = useStyles();
  const { bookings } = useServices();
  const [days, setDays] = useState(() =>
    DAYS.map((_, weekday) => {
      const w = initial.find((x) => x.weekday === weekday);
      return { on: !!w, start: w?.start ?? '09:00', end: w?.end ?? '17:00' };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<(typeof days)[number]>) =>
    setDays((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    const windows = days.flatMap((d, weekday) => (d.on ? [{ weekday, start: d.start, end: d.end }] : []));
    if (windows.some((w) => !TIME.test(w.start) || !TIME.test(w.end) || w.end <= w.start))
      return setError('Use times like 09:00 and 17:00, with the end after the start.');
    setBusy(true);
    setError(null);
    try {
      await bookings.saveAvailability(sellerProfileId, windows);
      onSaved();
    } catch (thrown) {
      setError(orderError(thrown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="service-hours">
      {error ? <Banner tone="danger" message={error} testID="hours-error" /> : null}
      <Text tone="muted">
        Buyers can request times inside these hours (Jamaica time). With no days on, any time can be
        requested.
      </Text>
      {days.map((d, i) => (
        <View key={DAYS[i]} style={styles.day}>
          <View style={styles.row}>
            <Text style={styles.flex}>{DAYS[i]}</Text>
            <Switch
              value={d.on}
              onValueChange={(on) => set(i, { on })}
              accessibilityLabel={`Available on ${DAYS[i]}`}
              testID={`hours-day-${i}`}
            />
          </View>
          {d.on ? (
            <View style={styles.row}>
              <View style={styles.flex}>
                <TextField
                  label="From"
                  value={d.start}
                  onChangeText={(start) => set(i, { start })}
                  testID={`hours-start-${i}`}
                />
              </View>
              <View style={styles.flex}>
                <TextField
                  label="To"
                  value={d.end}
                  onChangeText={(end) => set(i, { end })}
                  testID={`hours-end-${i}`}
                />
              </View>
            </View>
          ) : null}
        </View>
      ))}
      <Button title="Save hours" loading={busy} onPress={() => void save()} testID="hours-save" />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
  day: { gap: t.spacing.xs },
}));

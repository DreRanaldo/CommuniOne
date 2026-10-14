import type { AvailabilityWindow } from '@communione/services';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { LoadingState, Text } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { dateLabel, localToIso, nextDates, startTimes } from '../bookingRules';
import { ChipRow } from './ChipRow';

/** Date, length and start time for a booking, from the seller's hours and busy times. */
export function SlotPicker({
  sellerProfileId,
  onChange,
}: {
  sellerProfileId: string;
  onChange(slot: { startsAt: string; endsAt: string } | null): void;
}) {
  const styles = useStyles();
  const { bookings } = useServices();
  const dates = nextDates(14);
  const [date, setDate] = useState(dates[0]!);
  const [hours, setHours] = useState<'1' | '2' | '3' | '4'>('1');
  const [start, setStart] = useState<string>('');
  const load = useCallback(
    async (): Promise<[AvailabilityWindow[], { startsAt: string; endsAt: string }[]]> =>
      Promise.all([
        bookings.availability(sellerProfileId),
        bookings.busy(
          sellerProfileId,
          localToIso(dates[0]!, '00:00'),
          localToIso(dates[dates.length - 1]!, '23:00'),
        ),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dates change only with the day
    [bookings, sellerProfileId],
  );
  const data = useAsync(load);
  if (data.status === 'loading') return <LoadingState label="Loading free times…" />;
  const [windows, busy] = data.status === 'success' ? data.data : [[], []];
  const times = startTimes(date, Number(hours), windows, busy);

  const pick = (d: string, h: string, s: string) => {
    onChange(
      s
        ? {
            startsAt: localToIso(d, s),
            endsAt: new Date(Date.parse(localToIso(d, s)) + Number(h) * 3_600_000).toISOString(),
          }
        : null,
    );
  };

  return (
    <View style={styles.box} testID="slot-picker">
      <Text variant="label">Day</Text>
      <ChipRow<string>
        label="Day"
        options={dates.map((d) => ({ value: d, label: dateLabel(d) }))}
        value={date}
        onChange={(d) => {
          setDate(d);
          setStart('');
          pick(d, hours, '');
        }}
        testID="slot-day"
      />
      <Text variant="label">How long</Text>
      <ChipRow<'1' | '2' | '3' | '4'>
        label="How long"
        options={(['1', '2', '3', '4'] as const).map((h) => ({
          value: h,
          label: `${h} hour${h === '1' ? '' : 's'}`,
        }))}
        value={hours}
        onChange={(h) => {
          setHours(h);
          setStart('');
          pick(date, h, '');
        }}
        testID="slot-hours"
      />
      <Text variant="label">Start time (Jamaica time)</Text>
      {times.length === 0 ? (
        <Text tone="muted" testID="slot-none">
          No free times on this day.
        </Text>
      ) : (
        <ChipRow<string>
          label="Start time"
          options={times.map((t) => ({ value: t, label: t }))}
          value={start}
          onChange={(s) => {
            setStart(s);
            pick(date, hours, s);
          }}
          testID="slot-start"
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({ box: { gap: t.spacing.sm } }));

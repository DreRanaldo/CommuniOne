import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type CommunityEvent, type EventPatch } from '@communione/services';
import { useCallback, useLayoutEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import {
  deviceTimeZone,
  eventError,
  isValidTimeZone,
  parseEventForm,
  utcToZonedFields,
  type EventFormField,
  type EventFormText,
} from './eventRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'EventEditor'>;

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 10_000;
export const LOCATION_MAX = 500;

/** Create an event (draft or published at once), or edit one (loaded from the server). */
export function EventEditorScreen(props: Props) {
  const eventId = props.route.params?.eventId;
  const { events, communities } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<{ event: CommunityEvent | null; timeZone: string }> => {
    if (eventId) {
      const event = await events.get(eventId);
      if (event.community_id !== community.community_id) throw new Error('not in this community');
      return { event, timeZone: event.timezone };
    }
    // New events default to the community's time zone (else this device's).
    const zone = await communities
      .get(community.community_id)
      .then((c) => c.timezone)
      .catch(() => null);
    return { event: null, timeZone: zone && isValidTimeZone(zone) ? zone : deviceTimeZone() };
  }, [events, communities, eventId, community.community_id]);
  const loaded = useAsync(load);

  if (loaded.status === 'loading') return <LoadingState label="Loading the event…" />;
  if (loaded.status === 'error') {
    const gone = !isServiceError(loaded.error) || loaded.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This event is not available' : 'The event could not be loaded'}
        message={gone ? 'It may have been removed.' : errorMessage(loaded.error)}
        onRetry={gone ? undefined : loaded.reload}
      />
    );
  }
  return <Editor {...props} existing={loaded.data.event} defaultTimeZone={loaded.data.timeZone} />;
}

type Field = 'title' | 'description' | 'location' | EventFormField;

function initialForm(existing: CommunityEvent | null, timeZone: string): EventFormText {
  if (!existing) return { date: '', startTime: '', endDate: '', endTime: '', timeZone, capacity: '' };
  const start = utcToZonedFields(existing.starts_at, existing.timezone);
  const end = utcToZonedFields(existing.ends_at, existing.timezone);
  return {
    date: start.date,
    startTime: start.time,
    endDate: end.date === start.date ? '' : end.date,
    endTime: end.time,
    timeZone: existing.timezone,
    capacity: existing.capacity === null ? '' : String(existing.capacity),
  };
}

function Editor({
  navigation,
  existing,
  defaultTimeZone,
}: Props & { existing: CommunityEvent | null; defaultTimeZone: string }) {
  const styles = useStyles();
  const { events } = useServices();
  const community = useCommunity();
  const [initial] = useState(() => initialForm(existing, defaultTimeZone));
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [location, setLocation] = useState(existing?.location_text ?? '');
  const [form, setForm] = useState<EventFormText>(initial);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'publish' | 'save' | null>(null);
  const set = (key: EventFormField) => (text: string) => setForm((f) => ({ ...f, [key]: text }));

  useLayoutEffect(() => {
    navigation.setOptions({ title: existing ? 'Edit event' : 'New event' });
  }, [navigation, existing]);

  const save = async (mode: 'draft' | 'publish' | 'save') => {
    const found: Partial<Record<Field, string>> = {};
    if (!title.trim()) found.title = 'Enter a title.';
    else if ([...title.trim()].length > TITLE_MAX) found.title = `Use at most ${TITLE_MAX} characters.`;
    if ([...description].length > DESCRIPTION_MAX)
      found.description = `Use at most ${DESCRIPTION_MAX.toLocaleString()} characters.`;
    if ([...location].length > LOCATION_MAX) found.location = `Use at most ${LOCATION_MAX} characters.`;
    const parsed = parseEventForm(form);
    if ('errors' in parsed) Object.assign(found, parsed.errors);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0 || 'errors' in parsed) return;
    setSaving(mode);
    try {
      const { startsAt, endsAt, timeZone, capacity } = parsed.value;
      // The community comes from the current community; the organizer, status
      // dates, capacity and lifecycle rules are set and checked by the database.
      if (existing) {
        const patch: EventPatch = {
          title,
          description: description.trim() ? description : null,
          locationText: location.trim() ? location : null,
        };
        const timesChanged = (['date', 'startTime', 'endDate', 'endTime', 'timeZone'] as const).some(
          (k) => form[k] !== initial[k],
        );
        if (timesChanged) Object.assign(patch, { startsAt, endsAt, timezone: timeZone });
        if (capacity !== existing.capacity) patch.capacity = capacity;
        await events.edit(existing.id, patch);
      } else {
        await events.create({
          communityId: community.community_id,
          title,
          description: description.trim() ? description : null,
          locationText: location.trim() ? location : null,
          startsAt,
          endsAt,
          timezone: timeZone,
          capacity,
          publish: mode === 'publish',
        });
      }
      navigation.goBack();
    } catch (error) {
      const field = errorField(error);
      if (field === 'title' || field === 'description') setErrors({ [field]: errorMessage(error) });
      else if (field === 'capacity') setErrors({ capacity: eventError(error) });
      else setFormError(eventError(error));
      setSaving(null);
    }
  };

  return (
    <Screen testID="event-editor-screen">
      <Text tone="muted">
        {existing
          ? existing.status === 'published'
            ? 'Changes to a published event are shown at once and marked as edited.'
            : 'Editing a draft.'
          : `For everyone in ${community.name}.`}
      </Text>
      {formError ? <Banner tone="danger" message={formError} testID="event-editor-error" /> : null}
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={errors.title}
        maxLength={TITLE_MAX + 40}
      />
      <TextField
        label="Date"
        value={form.date}
        onChangeText={set('date')}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        error={errors.date}
      />
      <View style={styles.row}>
        <View style={styles.flex}>
          <TextField
            label="Starts at"
            value={form.startTime}
            onChangeText={set('startTime')}
            placeholder="HH:MM"
            keyboardType="numbers-and-punctuation"
            error={errors.startTime}
          />
        </View>
        <View style={styles.flex}>
          <TextField
            label="Ends at"
            value={form.endTime}
            onChangeText={set('endTime')}
            placeholder="HH:MM"
            keyboardType="numbers-and-punctuation"
            error={errors.endTime}
          />
        </View>
      </View>
      <TextField
        label="Ends on (optional)"
        value={form.endDate}
        onChangeText={set('endDate')}
        placeholder="YYYY-MM-DD"
        hint="Only for events that end on a later day."
        keyboardType="numbers-and-punctuation"
        error={errors.endDate}
      />
      <TextField
        label="Time zone"
        value={form.timeZone}
        onChangeText={set('timeZone')}
        autoCapitalize="none"
        autoCorrect={false}
        hint="The times above are in this zone, e.g. Europe/London."
        error={errors.timeZone}
      />
      <TextField
        label="Location (optional)"
        value={location}
        onChangeText={setLocation}
        error={errors.location}
        maxLength={LOCATION_MAX + 40}
      />
      <TextField
        label="Places (optional)"
        value={form.capacity}
        onChangeText={set('capacity')}
        keyboardType="number-pad"
        hint="Leave empty for no limit. When full, people who choose Going join a waitlist."
        error={errors.capacity}
      />
      <TextField
        label="Description (optional)"
        value={description}
        onChangeText={setDescription}
        multiline
        error={errors.description}
      />
      {existing ? (
        <Button title="Save changes" loading={saving === 'save'} onPress={() => void save('save')} />
      ) : (
        <>
          <Button
            title="Publish now"
            loading={saving === 'publish'}
            disabled={saving !== null}
            onPress={() => void save('publish')}
          />
          <Button
            title="Save as draft"
            variant="secondary"
            loading={saving === 'draft'}
            disabled={saving !== null}
            onPress={() => void save('draft')}
          />
        </>
      )}
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={saving !== null} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

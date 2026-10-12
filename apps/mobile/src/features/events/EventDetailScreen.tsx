import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type CommunityEvent } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Banner,
  Button,
  ErrorState,
  Icon,
  LoadingState,
  Screen,
  Text,
  TextField,
  type IconName,
} from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import {
  canManage,
  capacityText,
  eventError,
  eventSchedule,
  lifecycleActions,
  localStartNote,
  myRsvpText,
  RSVP_CHOICES,
  RSVP_LABELS,
  rsvpClosedReason,
  statusBadge,
  type AttendanceLike,
  type EventAction,
  type RsvpChoice,
} from './eventRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'EventDetail'>;
type Confirmable = Exclude<EventAction, 'edit'>;
type Notice = { tone: 'success' | 'danger'; message: string };

export const REASON_MAX = 500;

interface Loaded {
  event: CommunityEvent;
  attendance: AttendanceLike | null;
  organizer: string | null;
}

/** One event, read from the server with its attendance and organizer. */
export function EventDetailScreen({ navigation, route }: Props) {
  const { eventId } = route.params;
  const { events } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<Loaded> => {
    const event = await events.get(eventId);
    if (event.community_id !== community.community_id) throw new Error('not in this community');
    const [attendance, organizer] = await Promise.all([
      events.attendance(eventId).catch((error: unknown) => {
        // Drafts have no attendance for some viewers; a missing row is not an error.
        if (isServiceError(error) && error.code === ErrorCode.NotFound) return null;
        throw error;
      }),
      events.organizerName(event.created_by),
    ]);
    return { event, attendance, organizer };
  }, [events, eventId, community.community_id]);
  const current = useAsync(load);
  // Kept here so a message survives the reload that follows an action.
  const [notice, setNotice] = useState<Notice | null>(null);

  // Back from the editor: show the saved version.
  const { reload } = current;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        setNotice(null);
        reload();
      }
    }, [reload]),
  );

  if (current.status === 'loading') return <LoadingState label="Loading the event…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This event is not available' : 'The event could not be loaded'}
        message={gone ? 'It may have been removed.' : errorMessage(current.error)}
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  return (
    <Detail
      key={`${current.data.event.id}:${current.data.event.updated_at}:${current.data.attendance?.my_status}`}
      data={current.data}
      onEdit={() => navigation.navigate('EventEditor', { eventId })}
      onReload={current.reload}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

function Detail({
  data,
  onEdit,
  onReload,
  notice,
  onNotice,
}: {
  data: Loaded;
  onEdit(): void;
  onReload(): void;
  notice: Notice | null;
  onNotice(notice: Notice | null): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { events } = useServices();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const [e, setE] = useState(data.event);
  const [confirming, setConfirming] = useState<Confirmable | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState<RsvpChoice | 'remove' | null>(null);
  const inFlight = useRef(false);

  const when = eventSchedule(e);
  const local = localStartNote(e);
  const badge = statusBadge(e);
  const attendance = data.attendance;
  const closed = rsvpClosedReason(e);
  const manage = canManage(e, session?.user.id ?? null, permissions.can);
  const actions = manage ? lifecycleActions(e) : [];

  const question: Record<Confirmable, string> = {
    publish: 'Publish this event? Members can see it and reply.',
    discard: 'Discard this draft? It is kept in the records but never published.',
    cancel: 'Cancel this event? Members see that it was cancelled, and why if you say. Replies are closed.',
    complete: 'Mark this event as completed? Replies are closed and it moves to Past.',
  };
  const confirmLabel: Record<Confirmable, string> = {
    publish: 'Publish now',
    discard: 'Discard draft',
    cancel: 'Cancel event',
    complete: 'Mark completed',
  };
  const done: Record<Confirmable, string> = {
    publish: 'Published. Members can reply now.',
    discard: 'Draft discarded.',
    cancel: 'Cancelled. Replies are closed.',
    complete: 'Completed.',
  };

  const run = async (action: Confirmable) => {
    setBusy(true);
    onNotice(null);
    try {
      // Not optimistic: the server applies the lifecycle rules and stamps the dates.
      const updated =
        action === 'publish'
          ? await events.publish(e.id)
          : action === 'complete'
            ? await events.complete(e.id)
            : await events.cancel(e.id, action === 'cancel' && reason.trim() ? reason.trim() : undefined);
      setE(updated);
      setConfirming(null);
      setReason('');
      onNotice({ tone: 'success', message: done[action] });
    } catch (thrown) {
      onNotice({ tone: 'danger', message: eventError(thrown) });
      setConfirming(null);
      if (isServiceError(thrown) && thrown.code !== ErrorCode.Validation) onReload();
    } finally {
      setBusy(false);
    }
  };

  // RSVP: one request at a time, never optimistic (the server decides going vs waitlisted).
  const reply = async (choice: RsvpChoice | 'remove') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setReplying(choice);
    onNotice(null);
    try {
      if (choice === 'remove') {
        await events.cancelRsvp(e.id);
        onNotice({ tone: 'success', message: 'Your reply was removed.' });
      } else {
        const result = await events.rsvp(e.id, choice);
        onNotice(
          result.status === 'waitlisted'
            ? { tone: 'success', message: "The event is full. You're on the waitlist." }
            : {
                tone: 'success',
                message: `Your reply is saved: ${RSVP_LABELS[result.status] ?? result.status}.`,
              },
        );
      }
    } catch (thrown) {
      onNotice({ tone: 'danger', message: eventError(thrown) });
    } finally {
      inFlight.current = false;
      setReplying(null);
      // Places, the waitlist and my status come from the server.
      onReload();
    }
  };

  const selected = attendance?.my_status === 'waitlisted' ? 'going' : attendance?.my_status;
  return (
    <Screen testID="event-detail-screen">
      <View style={styles.header}>
        <Text variant="title" style={styles.flex}>
          {e.title}
        </Text>
        {badge ? (
          <View style={styles.badge}>
            <Text
              variant="caption"
              tone={e.status === 'cancelled' ? 'danger' : 'muted'}
              testID="event-status"
            >
              {badge}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.facts}>
        <Fact icon="calendar-outline" label="Date" testID="event-date" value={when.date} />
        <Fact icon="time-outline" label="Time" testID="event-time" value={when.time} />
        <Fact
          icon="globe-outline"
          label="Time zone"
          testID="event-timezone"
          value={local ? `${when.timezone}\n${local}` : when.timezone}
        />
        <Fact
          icon="location-outline"
          label="Location"
          testID="event-location"
          value={e.location_text ?? 'No location given'}
        />
        <Fact
          icon="people-outline"
          label="Places"
          testID="event-capacity"
          value={
            attendance ? capacityText(attendance) : e.capacity ? `${e.capacity} places` : 'No limit on places'
          }
        />
        <Fact
          icon="person-outline"
          label="Organizer"
          testID="event-organizer"
          value={data.organizer ?? (e.created_by ? 'A community member' : 'Deleted User')}
        />
      </View>

      {e.status === 'cancelled' && e.cancellation_reason ? (
        <Text testID="event-cancellation-reason">Reason for cancelling: {e.cancellation_reason}</Text>
      ) : null}
      {e.description ? (
        <>
          <View style={styles.divider} />
          <Text>{e.description}</Text>
        </>
      ) : null}

      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'success' ? 'event-done' : 'event-error'}
        />
      ) : null}

      {attendance ? (
        <View style={styles.panel} testID="event-rsvp">
          <Text variant="label" tone="muted">
            Your reply
          </Text>
          <View style={styles.row}>
            <Icon
              name={attendance.my_status === 'waitlisted' ? 'hourglass-outline' : 'person-circle-outline'}
              size={18}
              color={colors.text}
            />
            <Text variant="bodyStrong" style={styles.flex} testID="event-my-rsvp">
              {myRsvpText(attendance)}
            </Text>
          </View>
          {closed ? (
            <Text tone="muted" testID="event-rsvp-closed">
              {closed}
            </Text>
          ) : (
            <>
              <View style={styles.row} accessibilityRole="radiogroup">
                {RSVP_CHOICES.map((choice) => {
                  const on = selected === choice.value;
                  return (
                    <Pressable
                      key={choice.value}
                      accessibilityRole="radio"
                      accessibilityLabel={choice.label}
                      accessibilityState={{
                        checked: on,
                        disabled: replying !== null,
                        busy: replying === choice.value,
                      }}
                      disabled={replying !== null}
                      onPress={() => void reply(choice.value)}
                      style={[styles.choice, on && styles.choiceSelected]}
                    >
                      <Icon name={choice.icon} size={18} color={on ? colors.textInverse : colors.text} />
                      <Text variant="label" tone={on ? 'inverse' : 'default'}>
                        {choice.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {attendance.my_status ? (
                <Button
                  title="Remove my reply"
                  variant="ghost"
                  fullWidth={false}
                  loading={replying === 'remove'}
                  disabled={replying !== null}
                  onPress={() => void reply('remove')}
                />
              ) : null}
              {attendance.capacity !== null &&
              attendance.spots_left === 0 &&
              attendance.my_status !== 'going' ? (
                <Text variant="caption" tone="muted">
                  The event is full. Choosing Going puts you on the waitlist.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {actions.length > 0 ? (
        <View style={styles.panel} testID="event-controls">
          <Text variant="label" tone="muted">
            Manage
          </Text>
          {confirming ? (
            <View style={styles.confirm}>
              <Text>{question[confirming]}</Text>
              {confirming === 'cancel' ? (
                <TextField
                  label="Reason (optional)"
                  value={reason}
                  onChangeText={setReason}
                  maxLength={REASON_MAX}
                  hint="Shown to members, e.g. “Hall flooded”."
                />
              ) : null}
              <View style={styles.row}>
                <Button
                  title={confirmLabel[confirming]}
                  variant={confirming === 'publish' || confirming === 'complete' ? 'primary' : 'danger'}
                  fullWidth={false}
                  loading={busy}
                  onPress={() => void run(confirming)}
                />
                <Button
                  title="Go back"
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy}
                  onPress={() => {
                    setConfirming(null);
                    setReason('');
                  }}
                />
              </View>
            </View>
          ) : (
            <View style={styles.row}>
              {actions.includes('edit') ? (
                <Button title="Edit" variant="secondary" fullWidth={false} onPress={onEdit} />
              ) : null}
              {actions.includes('publish') ? (
                <Button title="Publish" fullWidth={false} onPress={() => setConfirming('publish')} />
              ) : null}
              {actions.includes('complete') ? (
                <Button
                  title="Mark completed"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setConfirming('complete')}
                />
              ) : null}
              {actions.includes('cancel') ? (
                <Button
                  title="Cancel event"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirming('cancel')}
                />
              ) : null}
              {actions.includes('discard') ? (
                <Button
                  title="Discard"
                  variant="ghost"
                  fullWidth={false}
                  accessibilityLabel="Discard draft"
                  onPress={() => setConfirming('discard')}
                />
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </Screen>
  );
}

function Fact({
  icon,
  label,
  testID,
  value,
}: {
  icon: IconName;
  label: string;
  testID: string;
  value: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      <Icon name={icon} size={18} color="textMuted" />
      <View style={styles.flex}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text testID={testID}>{value}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
  flex: { flex: 1 },
  badge: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  facts: { gap: t.spacing.sm },
  fact: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
  divider: { height: 1, backgroundColor: t.colors.border },
  panel: {
    gap: t.spacing.sm,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm },
  choice: {
    minHeight: t.touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  choiceSelected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  confirm: { gap: t.spacing.sm },
}));

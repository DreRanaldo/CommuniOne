import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Alert } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { SeverityBadge } from './AlertCard';
import {
  alertDates,
  alertError,
  alertState,
  canManage,
  lifecycleActions,
  SEVERITY_INFO,
  severityOf,
  statusBadge,
  type AlertAction,
} from './alertRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AlertDetail'>;
type Confirmable = Exclude<AlertAction, 'edit'>;
type Notice = { tone: 'success' | 'danger'; message: string };

export const REASON_MAX = 500;

const DONE: Record<Confirmable, string> = {
  publish: 'Issued. Members can see it now.',
  end: 'Ended. It is no longer active.',
  cancel: 'Cancelled. Members can see it was cancelled.',
  discard: 'Draft discarded.',
  archive: 'Archived.',
};

/** One alert, read from the server; management controls only when allowed. */
export function AlertDetailScreen({ navigation, route }: Props) {
  const { alertId } = route.params;
  const { alerts } = useServices();
  const community = useCommunity();
  const load = useCallback(async () => {
    const found = await alerts.get(alertId);
    if (found.community_id !== community.community_id) throw new Error('not in this community');
    return found;
  }, [alerts, alertId, community.community_id]);
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

  if (current.status === 'loading') return <LoadingState label="Loading the alert…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This alert is not available' : 'The alert could not be loaded'}
        message={gone ? 'It may have been withdrawn.' : errorMessage(current.error)}
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  return (
    <Detail
      key={`${current.data.id}:${current.data.updated_at}`}
      alert={current.data}
      communityName={community.name}
      onEdit={() => navigation.navigate('AlertEditor', { alertId })}
      onReload={current.reload}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

function Detail({
  alert: initial,
  communityName,
  onEdit,
  onReload,
  notice,
  onNotice,
}: {
  alert: Alert;
  communityName: string;
  onEdit(): void;
  onReload(): void;
  notice: Notice | null;
  onNotice(notice: Notice | null): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { alerts } = useServices();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const [a, setA] = useState(initial);
  const [confirming, setConfirming] = useState<Confirmable | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const level = severityOf(a.severity);
  const info = SEVERITY_INFO[level];
  const state = alertState(a);
  const emergency = level === 'emergency' && state === 'active';
  const manage = canManage(a, session?.user.id ?? null, permissions.can);
  const actions = manage ? lifecycleActions(a, permissions.can) : [];

  const question: Record<Confirmable, string> = {
    publish:
      level === 'emergency'
        ? `Issue this EMERGENCY alert now? It is shown first, in full, to everyone in ${communityName}.`
        : `Issue this ${info.label.toLowerCase()} alert now? Everyone in ${communityName} can see it.`,
    end: 'End this alert now? It stops being active and moves to History.',
    cancel: 'Cancel this alert? Members will see that it was cancelled, and why if you say.',
    discard: 'Discard this draft? It is kept in the records but never issued.',
    archive: 'Archive this alert? It stays in History.',
  };
  const confirmLabel: Record<Confirmable, string> = {
    publish: level === 'emergency' ? 'Issue emergency alert' : 'Issue now',
    end: 'End now',
    cancel: 'Cancel alert',
    discard: 'Discard draft',
    archive: 'Archive',
  };

  const run = async (action: Confirmable) => {
    setBusy(true);
    onNotice(null);
    try {
      // Not optimistic: the server applies the lifecycle rules and stamps the dates.
      const updated =
        action === 'publish'
          ? await alerts.publish(a.id)
          : action === 'end'
            ? await alerts.expire(a.id)
            : action === 'archive'
              ? await alerts.archive(a.id)
              : await alerts.cancel(a.id, action === 'cancel' && reason.trim() ? reason.trim() : undefined);
      setA(updated);
      setConfirming(null);
      setReason('');
      onNotice({ tone: 'success', message: DONE[action] });
    } catch (thrown) {
      onNotice({ tone: 'danger', message: alertError(thrown) });
      setConfirming(null);
      // The alert may have changed meanwhile: re-read it.
      if (isServiceError(thrown) && thrown.code !== ErrorCode.Validation) onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="alert-detail-screen">
      <View
        style={[styles.head, { borderLeftColor: colors.severity[level] }, emergency && styles.emergency]}
        accessible
        accessibilityRole={emergency ? 'alert' : undefined}
        accessibilityLiveRegion={emergency ? 'assertive' : undefined}
        accessibilityLabel={`${info.label} alert: ${a.title}. ${statusBadge(a)}. ${info.description}`}
        testID="alert-severity-header"
      >
        <View style={styles.row}>
          <SeverityBadge severity={level} inverse={emergency} />
          <View style={styles.status}>
            <Text variant="caption" tone="muted" testID="alert-status">
              {statusBadge(a)}
            </Text>
          </View>
        </View>
        <Text variant="title" tone={emergency ? 'inverse' : 'default'}>
          {a.title}
        </Text>
        <Text variant="label" tone={emergency ? 'inverse' : 'muted'}>
          {info.description}
        </Text>
      </View>
      <Text variant="label" tone="muted" testID="alert-dates">
        {alertDates(a)}
      </Text>
      {state === 'cancelled' && a.cancellation_reason ? (
        <Text testID="alert-cancellation-reason">Reason for cancelling: {a.cancellation_reason}</Text>
      ) : null}
      <View style={styles.divider} />
      <Text>{a.body}</Text>

      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'success' ? 'alert-done' : 'alert-error'}
        />
      ) : null}

      {actions.length > 0 ? (
        <View style={styles.controls} testID="alert-controls">
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
                  hint="Shown to members, e.g. “Water restored”."
                />
              ) : null}
              <View style={styles.row}>
                <Button
                  title={confirmLabel[confirming]}
                  variant={confirming === 'publish' || confirming === 'archive' ? 'primary' : 'danger'}
                  fullWidth={false}
                  loading={busy}
                  onPress={() => void run(confirming)}
                />
                <Button
                  title="Go back"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => {
                    setConfirming(null);
                    setReason('');
                  }}
                  disabled={busy}
                />
              </View>
            </View>
          ) : (
            <View style={styles.row}>
              {actions.includes('edit') ? (
                <Button title="Edit" variant="secondary" fullWidth={false} onPress={onEdit} />
              ) : null}
              {actions.includes('publish') ? (
                <Button title="Issue" fullWidth={false} onPress={() => setConfirming('publish')} />
              ) : null}
              {actions.includes('end') ? (
                <Button
                  title="End now"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setConfirming('end')}
                />
              ) : null}
              {actions.includes('cancel') ? (
                <Button
                  title="Cancel alert"
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
                  onPress={() => setConfirming('discard')}
                  accessibilityLabel="Discard draft"
                />
              ) : null}
              {actions.includes('archive') ? (
                <Button
                  title="Archive"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setConfirming('archive')}
                />
              ) : null}
            </View>
          )}
          {a.status === 'draft' && level === 'emergency' && !actions.includes('publish') ? (
            <Text variant="caption" tone="muted">
              Only people who manage alerts can issue an emergency alert.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  head: {
    gap: t.spacing.xs,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderLeftWidth: 8,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  emergency: { backgroundColor: t.colors.severity.emergency, borderColor: t.colors.severity.emergency },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm },
  status: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  divider: { height: 1, backgroundColor: t.colors.border },
  controls: {
    gap: t.spacing.sm,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  confirm: { gap: t.spacing.sm },
}));

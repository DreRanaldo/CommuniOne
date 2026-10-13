import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Notification } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDateTime } from '@/utils/format';
import { notificationKind, notificationTarget, TARGET_LABELS } from '../notificationRules';
import { useOpenNotification } from '../useOpenNotification';

type Props = NativeStackScreenProps<RootStackParamList, 'NotificationDetail'>;

/**
 * One notification in full (communione://notifications/<id>). It is read
 * from the server: only its owner gets it (RLS), so a link to someone
 * else's notification shows "not available". Viewing it marks it read; its
 * destination opens only if the database lets the user see it.
 */
export function NotificationDetailScreen({ route }: Props) {
  const { notificationId } = route.params;
  const { notifications } = useServices();
  const load = useCallback(() => notifications.get(notificationId), [notifications, notificationId]);
  const current = useAsync(load);

  if (current.status === 'loading') return <LoadingState label="Loading the notification…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This notification is not available' : 'The notification could not be loaded'}
        message={gone ? 'It may have been removed.' : errorMessage(current.error)}
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  return <Detail initial={current.data} />;
}

function Detail({ initial }: { initial: Notification }) {
  const styles = useStyles();
  const { notifications } = useServices();
  const { communities } = useCurrentCommunity();
  const open = useOpenNotification();
  const [n, setN] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = notificationKind(n.type);
  const target = notificationTarget(n);
  const community = n.community_id ? communities.find((c) => c.community_id === n.community_id) : undefined;

  // Seeing it in full marks it read (once).
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || initial.read_at) return;
    marked.current = true;
    notifications.markRead(initial.id).then(
      (changed) => changed && setN((x) => ({ ...x, read_at: new Date().toISOString() })),
      () => undefined,
    );
  }, [notifications, initial]);

  const toggleRead = async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (n.read_at) {
        await notifications.markUnread(n.id);
        setN({ ...n, read_at: null });
      } else {
        await notifications.markRead(n.id);
        setN({ ...n, read_at: new Date().toISOString() });
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    setBusy(true);
    setNotice(null);
    const result = await open({ ...n, read_at: n.read_at ?? new Date().toISOString() });
    if (!result.opened && result.message) setNotice(result.message);
    setBusy(false);
  };

  return (
    <Screen testID="notification-detail-screen">
      <View style={styles.kind}>
        <Icon name={kind.icon} size={20} color="primary" />
        <Text variant="label" tone="primary">
          {kind.label}
        </Text>
        <Text variant="caption" tone="muted" style={styles.state} testID="notification-state">
          {n.read_at ? 'Read' : 'Unread'}
        </Text>
      </View>
      <Text variant="title">{n.title}</Text>
      <Text variant="caption" tone="muted">
        {[community?.name, formatDateTime(n.created_at)].filter(Boolean).join(' · ')}
      </Text>
      {n.body ? <Text>{n.body}</Text> : null}
      {notice ? <Banner tone="danger" message={notice} testID="notification-error" /> : null}
      {target ? <Button title={TARGET_LABELS[target.kind]} onPress={() => void go()} loading={busy} /> : null}
      <Button
        title={n.read_at ? 'Mark as unread' : 'Mark as read'}
        variant="secondary"
        onPress={() => void toggleRead()}
        disabled={busy}
      />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  kind: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  state: { marginLeft: 'auto' },
}));

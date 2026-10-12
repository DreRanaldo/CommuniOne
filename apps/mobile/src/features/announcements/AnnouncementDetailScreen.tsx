import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Announcement } from '@communione/services';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import {
  announcementDates,
  announcementError,
  canManage,
  lifecycleActions,
  statusBadge,
} from './announcementRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AnnouncementDetail'>;
type Action = 'publish' | 'archive' | 'republish' | 'delete';

const CONFIRM: Record<Action, { question: string; button: string }> = {
  publish: { question: 'Publish this announcement? All members will be notified.', button: 'Publish now' },
  republish: {
    question: 'Publish this announcement again? Members will be notified.',
    button: 'Publish again',
  },
  archive: {
    question: 'Archive this announcement? It moves to "Past" and can be published again later.',
    button: 'Archive',
  },
  delete: { question: 'Delete this announcement? This cannot be undone.', button: 'Delete' },
};

/** One announcement, read from the server; management controls only when allowed. */
export function AnnouncementDetailScreen({ navigation, route }: Props) {
  const { announcementId } = route.params;
  const { announcements } = useServices();
  const community = useCommunity();
  const load = useCallback(async () => {
    const found = await announcements.get(announcementId);
    if (found.community_id !== community.community_id) throw new Error('not in this community');
    return found;
  }, [announcements, announcementId, community.community_id]);
  const current = useAsync(load);
  // Kept here so a message survives the reload that follows a refused action.
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);

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

  if (current.status === 'loading') return <LoadingState label="Loading the announcement…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This announcement is not available' : 'The announcement could not be loaded'}
        message={gone ? 'It may have been withdrawn.' : errorMessage(current.error)}
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  return (
    <Detail
      key={`${current.data.id}:${current.data.updated_at}`}
      announcement={current.data}
      onEdit={() => navigation.navigate('AnnouncementEditor', { announcementId })}
      onReload={current.reload}
      onDeleted={() => navigation.goBack()}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

function Detail({
  announcement: initial,
  onEdit,
  onReload,
  onDeleted,
  notice,
  onNotice,
}: {
  announcement: Announcement;
  onEdit(): void;
  onReload(): void;
  onDeleted(): void;
  notice: { tone: 'success' | 'danger'; message: string } | null;
  onNotice(notice: { tone: 'success' | 'danger'; message: string } | null): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { announcements } = useServices();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const [a, setA] = useState(initial);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);

  const important = a.priority === 'important';
  const badge = statusBadge(a);
  const manage = canManage(a, session?.user.id ?? null, permissions.can);
  const actions = manage ? lifecycleActions(a.status) : [];

  const run = async (action: Action) => {
    setBusy(true);
    onNotice(null);
    try {
      // Not optimistic: the server applies the lifecycle rules and stamps the dates.
      const updated =
        action === 'archive'
          ? await announcements.archive(a.id)
          : action === 'delete'
            ? await announcements.delete(a.id)
            : await announcements.publish(a.id);
      setConfirming(null);
      if (action === 'delete') {
        onDeleted();
        return;
      }
      setA(updated);
      onNotice({
        tone: 'success',
        message: action === 'archive' ? 'Archived.' : 'Published. Members have been notified.',
      });
    } catch (thrown) {
      onNotice({ tone: 'danger', message: announcementError(thrown) });
      setConfirming(null);
      // The announcement may have changed meanwhile: re-read it.
      if (isServiceError(thrown) && thrown.code !== ErrorCode.Validation) onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="announcement-detail-screen">
      <View style={[styles.eyebrow]}>
        <Icon name="megaphone" size={18} color={important ? colors.severity.urgent : colors.primary} />
        <Text variant="label" style={{ color: important ? colors.severity.urgent : colors.primary }}>
          {important ? 'Important announcement' : 'Announcement'}
        </Text>
        {badge ? (
          <Text variant="caption" tone="muted" style={styles.badge} testID="announcement-status">
            {badge}
          </Text>
        ) : null}
      </View>
      <Text variant="title">{a.title}</Text>
      <Text variant="label" tone="muted" testID="announcement-dates">
        {announcementDates(a)}
      </Text>
      <View style={styles.divider} />
      <Text>{a.body}</Text>

      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'success' ? 'announcement-done' : 'announcement-error'}
        />
      ) : null}

      {actions.length > 0 ? (
        <View style={styles.controls} testID="announcement-controls">
          <Text variant="label" tone="muted">
            Manage
          </Text>
          {confirming ? (
            <View style={styles.confirm}>
              <Text>{CONFIRM[confirming].question}</Text>
              <View style={styles.row}>
                <Button
                  title={CONFIRM[confirming].button}
                  variant={confirming === 'delete' ? 'danger' : 'primary'}
                  fullWidth={false}
                  loading={busy}
                  onPress={() => void run(confirming)}
                />
                <Button
                  title="Cancel"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirming(null)}
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
                <Button title="Publish" fullWidth={false} onPress={() => setConfirming('publish')} />
              ) : null}
              {actions.includes('republish') ? (
                <Button title="Publish again" fullWidth={false} onPress={() => setConfirming('republish')} />
              ) : null}
              {actions.includes('archive') ? (
                <Button
                  title="Archive"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setConfirming('archive')}
                />
              ) : null}
              {actions.includes('delete') ? (
                <Button
                  title="Delete"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirming('delete')}
                  accessibilityLabel="Delete announcement"
                />
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  badge: {
    marginLeft: 'auto',
    paddingHorizontal: t.spacing.sm,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
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
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  confirm: { gap: t.spacing.sm },
}));

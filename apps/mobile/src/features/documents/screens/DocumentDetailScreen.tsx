import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Document } from '@communione/services';
import { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useAuth } from '@/features/auth/AuthProvider';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';
import { documentActions, documentError, fileKind, formatSize } from '../documentRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'DocumentDetail'>;

/** How long a download link works. Short: it is created on demand, for this tap only. */
export const LINK_SECONDS = 60;

/**
 * One document of the current community: read from the server (RLS: members
 * with documents.view; managers-only and archived documents need
 * documents.manage), refused if it belongs to another community. The file
 * opens through a short-lived signed link created on demand; there are no
 * permanent URLs. Rename, archive and delete appear when allowed and are
 * authorized again by the database.
 */
export function DocumentDetailScreen({ route, navigation }: Props) {
  const { documentId } = route.params;
  const { documents } = useServices();
  const community = useCommunity();
  const load = useCallback(async () => {
    const doc = await documents.get(documentId);
    if (doc.community_id !== community.community_id) throw new Error('not in this community');
    if (doc.status === 'deleted' || doc.status === 'pending_upload') throw new Error('not available');
    return doc;
  }, [documents, documentId, community.community_id]);
  const current = useAsync(load);

  if (current.status === 'loading') return <LoadingState label="Loading the document…" />;
  if (current.status === 'error') {
    const gone = !isServiceError(current.error) || current.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This document is not available' : 'The document could not be loaded'}
        message={
          gone ? 'It may have been removed, or you may not have access to it.' : errorMessage(current.error)
        }
        onRetry={gone ? undefined : current.reload}
      />
    );
  }
  return <Detail initial={current.data} onDeleted={() => navigation.goBack()} />;
}

type Notice = { tone: 'success' | 'danger'; message: string } | null;

function Detail({ initial, onDeleted }: { initial: Document; onDeleted(): void }) {
  const styles = useStyles();
  const { documents } = useServices();
  const { session } = useAuth();
  const permissions = useCommunityPermissions();
  const [doc, setDoc] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<null | 'open' | 'rename' | 'archive' | 'delete'>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const userId = session?.user.id ?? null;
  const actions = documentActions(doc, userId, permissions.can);
  const kind = fileKind(doc.file_extension);

  const run = async (what: 'rename' | 'archive' | 'delete', fn: () => Promise<Document>, done: string) => {
    setBusy(what);
    setNotice(null);
    try {
      const updated = await fn();
      if (what === 'delete') {
        onDeleted();
        return;
      }
      setDoc(updated);
      setRenaming(null);
      setNotice({ tone: 'success', message: done });
    } catch (thrown) {
      setNotice({ tone: 'danger', message: documentError(thrown) });
      // It may have changed meanwhile (archived, renamed, permissions): re-read it quietly.
      if (isServiceError(thrown) && thrown.code !== ErrorCode.Validation)
        documents.get(doc.id).then(setDoc, () => undefined);
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  const openFile = async () => {
    setBusy('open');
    setNotice(null);
    try {
      const url = await documents.getDownloadUrl(doc.id, LINK_SECONDS);
      await Linking.openURL(url);
    } catch (thrown) {
      setNotice({ tone: 'danger', message: documentError(thrown) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen testID="document-detail-screen">
      <View style={styles.row}>
        <Icon name={kind.icon} size={28} color="primary" />
        <Text variant="title" style={styles.flex} testID="document-name">
          {doc.name}
        </Text>
      </View>
      <Text tone="muted" testID="document-facts">
        {[
          kind.label,
          formatSize(doc.file_size),
          `Added ${formatDate(doc.uploaded_at ?? doc.created_at)}`,
        ].join(' · ')}
      </Text>
      <Text variant="caption" tone="muted" testID="document-access">
        {[
          doc.visibility === 'managers' ? 'Managers only' : 'Everyone with access to documents',
          userId && doc.uploaded_by === userId ? 'Uploaded by you' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {doc.status === 'archived' ? (
        <Banner message="This document is archived. Members can't see it." />
      ) : null}
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'success' ? 'document-done' : 'document-error'}
        />
      ) : null}
      <Button title="Open document" onPress={() => void openFile()} loading={busy === 'open'} />

      {actions.rename || actions.archive || actions.delete ? (
        <View style={styles.controls} testID="document-controls">
          <Text variant="label" tone="muted">
            Manage
          </Text>
          {renaming !== null ? (
            <View style={styles.confirm}>
              <TextField label="Name" value={renaming} onChangeText={setRenaming} maxLength={255} autoFocus />
              <View style={styles.actions}>
                <Button
                  title="Save name"
                  fullWidth={false}
                  loading={busy === 'rename'}
                  disabled={!renaming.trim() || renaming.trim() === doc.name}
                  onPress={() =>
                    void run('rename', () => documents.rename(doc.id, renaming.trim()), 'Renamed.')
                  }
                />
                <Button title="Cancel" variant="ghost" fullWidth={false} onPress={() => setRenaming(null)} />
              </View>
            </View>
          ) : confirmDelete ? (
            <View style={styles.confirm}>
              <Text>Delete this document? Members will no longer be able to open it.</Text>
              <View style={styles.actions}>
                <Button
                  title="Delete"
                  variant="danger"
                  fullWidth={false}
                  loading={busy === 'delete'}
                  onPress={() => void run('delete', () => documents.delete(doc.id), 'Deleted.')}
                />
                <Button
                  title="Cancel"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirmDelete(false)}
                  disabled={busy !== null}
                />
              </View>
            </View>
          ) : (
            <View style={styles.actions}>
              {actions.rename ? (
                <Button
                  title="Rename"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setRenaming(doc.name)}
                />
              ) : null}
              {actions.archive ? (
                <Button
                  title={doc.status === 'archived' ? 'Restore' : 'Archive'}
                  variant="secondary"
                  fullWidth={false}
                  loading={busy === 'archive'}
                  onPress={() =>
                    void run(
                      'archive',
                      () =>
                        doc.status === 'archived' ? documents.restore(doc.id) : documents.archive(doc.id),
                      doc.status === 'archived' ? 'Restored.' : 'Archived.',
                    )
                  }
                />
              ) : null}
              {actions.delete ? (
                <Button
                  title="Delete"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirmDelete(true)}
                  accessibilityLabel="Delete document"
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
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
  controls: { gap: t.spacing.sm, marginTop: t.spacing.md },
  confirm: { gap: t.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
}));

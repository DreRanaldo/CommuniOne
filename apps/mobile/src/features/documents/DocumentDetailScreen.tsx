import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Document } from '@communione/services';
import { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';

type Props = NativeStackScreenProps<CommunityStackParamList, 'DocumentDetail'>;

const size = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * One document of the current community (where a notification leads): read
 * from the server (RLS: members with documents.view; managers-only documents
 * need documents.manage), refused if it belongs to another community. The
 * file opens through a short-lived signed link created on demand.
 * The full document library belongs to a later stage.
 */
export function DocumentDetailScreen({ route }: Props) {
  const { documentId } = route.params;
  const { documents } = useServices();
  const community = useCommunity();
  const load = useCallback(async () => {
    const doc = await documents.get(documentId);
    if (doc.community_id !== community.community_id) throw new Error('not in this community');
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
  return <Detail doc={current.data} />;
}

function Detail({ doc }: { doc: Document }) {
  const styles = useStyles();
  const { documents } = useServices();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFile = async () => {
    setOpening(true);
    setError(null);
    try {
      const url = await documents.getDownloadUrl(doc.id, 60);
      await Linking.openURL(url);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setOpening(false);
    }
  };

  return (
    <Screen testID="document-detail-screen">
      <View style={styles.row}>
        <Icon name="document-text-outline" size={28} color="primary" />
        <Text variant="title" style={styles.flex}>
          {doc.name}
        </Text>
      </View>
      <Text tone="muted" testID="document-facts">
        {[
          doc.file_extension.toUpperCase(),
          size(doc.file_size),
          `Added ${formatDate(doc.uploaded_at ?? doc.created_at)}`,
        ].join(' · ')}
      </Text>
      {doc.status !== 'active' ? <Banner message={`This document is ${doc.status}.`} /> : null}
      {error ? <Banner tone="danger" message={error} testID="document-error" /> : null}
      <Button title="Open document" onPress={() => void openFile()} loading={opening} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

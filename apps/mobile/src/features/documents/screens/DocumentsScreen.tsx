import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Folder } from '@communione/services';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { DocumentItem, FolderItem } from '../DocumentItem';
import { useDocumentList, type DocumentView } from '../useDocumentList';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Documents'>;

/**
 * The current community's documents: folders first, then documents, newest
 * first, page by page. Inside a folder: its subfolders and documents.
 * "Upload" appears with documents.upload, "Archived" with documents.manage
 * (display only: the database decides what each user receives and may do).
 */
export function DocumentsScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const folderId = route.params?.folderId ?? null;
  const permissions = useCommunityPermissions();
  const canUpload = permissions.can('documents.upload');
  const manager = permissions.can('documents.manage');
  const [view, setView] = useState<DocumentView>('active');

  useLayoutEffect(() => {
    navigation.setOptions({
      title: route.params?.folderName ?? 'Documents',
      headerRight: canUpload
        ? () => (
            <Button
              title="Upload"
              variant="ghost"
              fullWidth={false}
              onPress={() =>
                navigation.navigate('DocumentUpload', {
                  folderId: folderId ?? undefined,
                  folderName: route.params?.folderName,
                })
              }
              accessibilityLabel="Upload a document"
            />
          )
        : undefined,
    });
  }, [navigation, canUpload, folderId, route.params?.folderName]);

  const views: { view: DocumentView; label: string }[] = [
    { view: 'active', label: 'Documents' },
    { view: 'archived', label: 'Archived' },
  ];
  return (
    <View style={styles.container} testID="documents-screen">
      {manager && !folderId ? (
        <View style={styles.tabs} accessibilityRole="tablist">
          {views.map((v) => (
            <Pressable
              key={v.view}
              accessibilityRole="tab"
              accessibilityLabel={v.label}
              accessibilityState={{ selected: v.view === view }}
              onPress={() => setView(v.view)}
              style={[styles.tab, v.view === view && styles.tabSelected]}
            >
              <Text variant="label" tone={v.view === view ? 'default' : 'muted'}>
                {v.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <DocumentList key={`${view}:${folderId ?? ''}`} view={view} folderId={folderId} />
    </View>
  );
}

function DocumentList({ view, folderId }: { view: DocumentView; folderId: string | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const navigation = useNavigation<Props['navigation']>();
  const { documents } = useServices();
  const community = useCommunity();
  const list = useDocumentList(community.community_id, folderId, view);
  const loadFolders = useCallback(
    async (): Promise<Folder[]> =>
      view === 'archived'
        ? []
        : (await documents.listFolders(community.community_id)).filter(
            (f) => f.community_id === community.community_id && f.parent_folder_id === folderId,
          ),
    [documents, community.community_id, folderId, view],
  );
  const folders = useAsync(loadFolders);
  const folderRows = folders.status === 'success' ? folders.data : [];

  // Back from a document, the upload or a folder: show the server's current list.
  const { refresh } = list;
  const reloadFolders = folders.reload;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        void refresh();
        reloadFolders();
      }
    }, [refresh, reloadFolders]),
  );

  if (list.status === 'loading') return <LoadingState label="Loading documents…" />;
  if (list.status === 'error' && list.items.length === 0) {
    return (
      <ErrorState
        title="Documents could not be loaded"
        message={errorMessage(list.error)}
        onRetry={list.retry}
      />
    );
  }
  return (
    <FlatList
      testID="documents-list"
      data={list.items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <DocumentItem
          doc={item}
          onPress={() => navigation.navigate('DocumentDetail', { documentId: item.id })}
        />
      )}
      ListHeaderComponent={
        folderRows.length ? (
          <View testID="folders">
            {folderRows.map((f) => (
              <FolderItem
                key={f.id}
                folder={f}
                onPress={() => navigation.push('Documents', { folderId: f.id, folderName: f.name })}
              />
            ))}
          </View>
        ) : null
      }
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => {
            void list.refresh();
            folders.reload();
          }}
          tintColor={colors.primary}
        />
      }
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        folderRows.length ? null : (
          <EmptyState
            icon="document-text-outline"
            title={
              view === 'archived'
                ? 'No archived documents.'
                : folderId
                  ? 'This folder is empty.'
                  : 'No documents yet.'
            }
          />
        )
      }
      ListFooterComponent={
        <View style={styles.footer}>
          {list.error ? (
            <Text tone="danger" accessibilityRole="alert">
              {errorMessage(list.error)}
            </Text>
          ) : null}
          {list.hasMore ? (
            <Button
              title="Load more documents"
              variant="ghost"
              loading={list.loadingMore}
              onPress={list.loadMore}
            />
          ) : null}
        </View>
      }
    />
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  tabs: {
    flexDirection: 'row',
    gap: t.spacing.lg,
    paddingHorizontal: t.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  tab: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabSelected: { borderBottomColor: t.colors.text },
  list: { flexGrow: 1 },
  footer: { alignItems: 'center', gap: t.spacing.sm, padding: t.spacing.md },
}));

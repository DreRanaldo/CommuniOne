import { useFocusEffect } from '@react-navigation/native';
import type { ListingCard } from '@communione/services';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, useWindowDimensions } from 'react-native';
import { Button, EmptyState, ErrorState, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import { errorMessage } from '@/utils/errors';
import { marketError } from '../marketRules';
import { useListingSearch, type ListingFilters } from '../useListingSearch';
import { ListingTile } from './ListingTile';

/** A two-column grid of storefront results for fixed filters (a seller's listings, saved listings). */
export function ListingResults({
  filters,
  header,
  empty,
  onOpen,
  removeWhenUnsaved,
  testID,
}: {
  filters: ListingFilters;
  header?: ReactElement;
  empty: { title: string; message?: string };
  onOpen(listingId: string): void;
  /** Saved listings: unsaving removes the tile. */
  removeWhenUnsaved?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const community = useCommunity();
  const { marketplace } = useServices();
  const results = useListingSearch(community.community_id, filters);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const { refresh } = results;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        setHidden(new Set());
        void refresh();
      }
    }, [refresh]),
  );

  const toggle = async (l: ListingCard) => {
    setNotice(null);
    results.patch(l.id, { isFavorite: !l.isFavorite });
    if (removeWhenUnsaved && l.isFavorite) setHidden((h) => new Set(h).add(l.id));
    try {
      await marketplace.setFavorite(l.id, !l.isFavorite);
    } catch (thrown) {
      results.patch(l.id, { isFavorite: l.isFavorite });
      setHidden((h) => {
        const next = new Set(h);
        next.delete(l.id);
        return next;
      });
      setNotice(marketError(thrown));
    }
  };

  if (results.status === 'loading') return <LoadingState label="Loading listings…" />;
  if (results.status === 'error' && results.items.length === 0)
    return (
      <ErrorState
        title="Listings could not be loaded"
        message={errorMessage(results.error)}
        onRetry={results.retry}
      />
    );
  const tileWidth = (width - 16 * 2 - 12) / 2;
  return (
    <FlatList
      testID={testID}
      data={results.items.filter((l) => !hidden.has(l.id))}
      keyExtractor={(l) => l.id}
      numColumns={2}
      columnWrapperStyle={styles.columns}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <>
          {header}
          {notice ? (
            <Text tone="danger" accessibilityRole="alert" style={styles.notice}>
              {notice}
            </Text>
          ) : null}
        </>
      }
      renderItem={({ item }) => (
        <ListingTile
          listing={item}
          width={tileWidth}
          onPress={() => onOpen(item.id)}
          onToggleFavorite={() => void toggle(item)}
        />
      )}
      onEndReached={results.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={results.refreshing}
          onRefresh={() => void results.refresh()}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        <EmptyState icon="storefront-outline" title={empty.title} message={empty.message} />
      }
      ListFooterComponent={
        results.loadingMore ? (
          <ActivityIndicator color={colors.primary} />
        ) : results.hasMore ? (
          <Button title="Show more" variant="ghost" onPress={results.loadMore} />
        ) : null
      }
    />
  );
}

const useStyles = makeStyles((t) => ({
  list: { paddingVertical: t.spacing.md, gap: 12, flexGrow: 1 },
  columns: { gap: 12, paddingHorizontal: t.spacing.lg },
  notice: { paddingHorizontal: t.spacing.lg },
}));

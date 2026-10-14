import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ListingCard } from '@communione/services';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Switch,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, ErrorState, Icon, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { ChipRow } from '../components/ChipRow';
import { ListingTile } from '../components/ListingTile';
import { canSell, CONDITION_LABELS, marketError, parsePrice, SORT_LABELS } from '../marketRules';
import { useListingSearch, type ListingFilters } from '../useListingSearch';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Market'>;

export const MARKET_SEARCH_DELAY_MS = 300;

type Kind = 'all' | 'product' | 'service';
type Condition = 'any' | 'new' | 'like_new' | 'good' | 'fair';
type Sort = keyof typeof SORT_LABELS;

/**
 * The Market tab (Stage B): the current community's storefront. Search,
 * categories, sorting and filters run on the server (search_listings), which
 * returns only active listings of active sellers in this community.
 */
export function MarketHomeScreen({ navigation }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const { marketplace } = useServices();
  const { width } = useWindowDimensions();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [condition, setCondition] = useState<Condition>('any');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), MARKET_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const loadCategories = useCallback(() => marketplace.categories(), [marketplace]);
  const { cart } = useServices();
  const canBuy = permissions.can('marketplace.buy');
  const loadCount = useCallback(
    () => (canBuy ? cart.count(community.community_id) : Promise.resolve(0)),
    [cart, community.community_id, canBuy],
  );
  const cartCount = useAsync(loadCount);
  const reloadCount = cartCount.reload;
  const categories = useAsync(loadCategories);

  const min = parsePrice(minText);
  const max = parsePrice(maxText);
  const priceError = 'error' in min ? min.error : 'error' in max ? max.error : null;
  const filters = useMemo<ListingFilters>(
    () => ({
      query: query || undefined,
      categoryId: category === 'all' ? undefined : category,
      kind: kind === 'all' ? undefined : kind,
      condition: condition === 'any' ? undefined : condition,
      minPriceMinor: 'minor' in min && min.minor !== null ? min.minor : undefined,
      maxPriceMinor: 'minor' in max && max.minor !== null ? max.minor : undefined,
      inStockOnly: inStockOnly || undefined,
      sort: sort === 'relevance' && !query ? 'newest' : sort,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- min/max are derived from the texts
    [query, category, kind, condition, minText, maxText, inStockOnly, sort],
  );
  const results = useListingSearch(community.community_id, filters);

  // Back from a listing or the shop: the server's current results.
  const { refresh } = results;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        void refresh();
        reloadCount();
      }
    }, [refresh, reloadCount]),
  );

  if (!permissions.can('marketplace.view')) {
    return (
      <EmptyState
        icon="storefront-outline"
        title="Marketplace not available"
        message={`You can't use the marketplace in ${community.name}.`}
      />
    );
  }

  const toggleFavorite = async (l: ListingCard) => {
    setNotice(null);
    results.patch(l.id, { isFavorite: !l.isFavorite });
    try {
      await marketplace.setFavorite(l.id, !l.isFavorite);
    } catch (thrown) {
      results.patch(l.id, { isFavorite: l.isFavorite });
      setNotice(marketError(thrown));
    }
  };

  const tileWidth = (width - 16 * 2 - 12) / 2;
  const categoryOptions = [
    { value: 'all', label: 'All' },
    ...(categories.status === 'success'
      ? categories.data
          .filter((c) => kind === 'all' || c.kind === kind)
          .map((c) => ({ value: c.id, label: c.name }))
      : []),
  ];

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <View style={styles.flex}>
          <Text variant="caption" tone="muted">
            {`${community.name.toUpperCase()} MARKETPLACE`}
          </Text>
          <Text variant="display">Market</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Saved listings"
          onPress={() => navigation.navigate('SavedListings')}
          style={styles.round}
          testID="market-saved"
        >
          <Icon name="heart-outline" size={22} color="text" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Your orders"
          onPress={() => navigation.navigate('Orders')}
          style={styles.round}
          testID="market-orders"
        >
          <Icon name="receipt-outline" size={22} color="text" />
        </Pressable>
        {canBuy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cart, ${cartCount.status === 'success' ? cartCount.data : 0} items`}
            onPress={() => navigation.navigate('Cart')}
            style={styles.round}
            testID="market-cart"
          >
            <Icon name="cart-outline" size={22} color="text" />
            {cartCount.status === 'success' && cartCount.data > 0 ? (
              <View style={styles.badge}>
                <Text variant="caption" tone="inverse">
                  {cartCount.data > 99 ? '99+' : cartCount.data}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        {canSell(permissions.can) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Your shop"
            onPress={() => navigation.navigate('Shop')}
            style={[styles.round, styles.sell]}
            testID="market-shop"
          >
            <Icon name="storefront-outline" size={22} color="onPrimary" />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.search}>
        <Icon name="search-outline" size={20} color="textMuted" />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`Search ${community.name}`}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Search the marketplace"
          style={styles.input}
          autoCorrect={false}
          maxLength={100}
          returnKeyType="search"
        />
        {text ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => setText('')}
            hitSlop={8}
          >
            <Icon name="close-circle" size={20} color="textMuted" />
          </Pressable>
        ) : null}
      </View>
      <ChipRow
        options={categoryOptions}
        value={category}
        onChange={setCategory}
        label="Category"
        testID="market-categories"
      />
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showFilters ? 'Hide filters' : 'Show filters'}
          accessibilityState={{ expanded: showFilters }}
          onPress={() => setShowFilters((s) => !s)}
          style={styles.filterButton}
        >
          <Icon name="options-outline" size={18} color="text" />
          <Text variant="label">Filters</Text>
        </Pressable>
      </View>
      <ChipRow<Sort>
        options={(Object.keys(SORT_LABELS) as Sort[])
          .filter((s) => s !== 'relevance' || query)
          .map((s) => ({ value: s, label: SORT_LABELS[s] }))}
        value={sort === 'relevance' && !query ? 'newest' : sort}
        onChange={setSort}
        label="Sort by"
        testID="market-sort"
      />
      {showFilters ? (
        <View style={styles.filters} testID="market-filters">
          <ChipRow
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'product', label: 'Products' },
              { value: 'service', label: 'Services' },
            ]}
            value={kind}
            onChange={(k: Kind) => {
              setKind(k);
              setCategory('all');
            }}
            label="Listing type"
          />
          {kind !== 'service' ? (
            <ChipRow<Condition>
              options={[{ value: 'any' as Condition, label: 'Any condition' }].concat(
                (Object.keys(CONDITION_LABELS) as Condition[]).map((c) => ({
                  value: c,
                  label: CONDITION_LABELS[c]!,
                })),
              )}
              value={condition}
              onChange={setCondition}
              label="Condition"
            />
          ) : null}
          <View style={styles.priceRow}>
            <TextInput
              value={minText}
              onChangeText={setMinText}
              placeholder="Min J$"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              accessibilityLabel="Minimum price"
              style={styles.priceInput}
            />
            <Text tone="muted">to</Text>
            <TextInput
              value={maxText}
              onChangeText={setMaxText}
              placeholder="Max J$"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              accessibilityLabel="Maximum price"
              style={styles.priceInput}
            />
          </View>
          {priceError ? (
            <Text tone="danger" variant="caption">
              {priceError}
            </Text>
          ) : null}
          <View style={styles.switchRow}>
            <Text style={styles.flex}>In stock only</Text>
            <Switch
              value={inStockOnly}
              onValueChange={setInStockOnly}
              accessibilityLabel="In stock only"
              trackColor={{ true: colors.primary, false: colors.border }}
            />
          </View>
        </View>
      ) : null}
      {notice ? (
        <Text tone="danger" accessibilityRole="alert" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container} testID="market-screen">
      {results.status === 'loading' ? (
        <View style={styles.flex}>
          {header}
          <LoadingState label="Loading the marketplace…" />
        </View>
      ) : results.status === 'error' && results.items.length === 0 ? (
        <View style={styles.flex}>
          {header}
          <ErrorState
            title="The marketplace could not be loaded"
            message={errorMessage(results.error)}
            onRetry={results.retry}
          />
        </View>
      ) : (
        <FlatList
          testID="market-results"
          data={results.items}
          keyExtractor={(l) => l.id}
          numColumns={2}
          columnWrapperStyle={styles.columns}
          contentContainerStyle={styles.list}
          ListHeaderComponent={header}
          renderItem={({ item }) => (
            <ListingTile
              listing={item}
              width={tileWidth}
              onPress={() => navigation.navigate('Listing', { listingId: item.id })}
              onToggleFavorite={() => void toggleFavorite(item)}
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
            <EmptyState
              icon="storefront-outline"
              title={query ? `Nothing matches “${query}”` : 'Nothing for sale yet'}
              message={
                canSell(permissions.can)
                  ? 'Be the first: open your shop and list something.'
                  : 'Listings from your neighbours will appear here.'
              }
              action={
                canSell(permissions.can) && !query
                  ? { title: 'Start selling', onPress: () => navigation.navigate('Shop') }
                  : undefined
              }
            />
          }
          ListFooterComponent={
            results.loadingMore ? (
              <ActivityIndicator color={colors.primary} style={styles.footer} />
            ) : results.hasMore ? (
              <Button title="Show more" variant="ghost" onPress={results.loadMore} />
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  flex: { flex: 1 },
  header: { gap: t.spacing.sm, paddingBottom: t.spacing.sm },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  sell: { backgroundColor: t.colors.primary },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.danger,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    marginHorizontal: t.spacing.lg,
    paddingHorizontal: t.spacing.md,
    minHeight: 48,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceMuted,
  },
  input: { flex: 1, color: t.colors.text, fontSize: 16, paddingVertical: t.spacing.sm },
  toolbar: { flexDirection: 'row', paddingHorizontal: t.spacing.lg },
  filterButton: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, minHeight: 36 },
  filters: {
    gap: t.spacing.sm,
    marginHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: t.colors.border,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
  },
  priceInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    color: t.colors.text,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg },
  notice: { paddingHorizontal: t.spacing.lg },
  list: { paddingBottom: t.spacing.xl, gap: 12 },
  columns: { gap: 12, paddingHorizontal: t.spacing.lg },
  footer: { paddingVertical: t.spacing.md },
}));

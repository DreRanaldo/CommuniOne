import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { ErrorState, Icon, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { ListingResults } from '../components/ListingResults';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Seller'>;

/** A seller's shop in the current community: name, description and active listings. */
export function SellerScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { marketplace } = useServices();
  const community = useCommunity();
  const { sellerProfileId } = route.params;
  const load = useCallback(async () => {
    const seller = await marketplace.sellerProfile(sellerProfileId);
    if (seller.communityId !== community.community_id) throw new Error('not in this community');
    return seller;
  }, [marketplace, sellerProfileId, community.community_id]);
  const seller = useAsync(load);
  const filters = useMemo(() => ({ sellerProfileId }), [sellerProfileId]);

  if (seller.status === 'loading') return <LoadingState label="Loading the shop…" />;
  if (seller.status === 'error')
    return <ErrorState title="This shop is not available" message="It may have closed or been suspended." />;
  const s = seller.data;
  return (
    <View style={styles.container} testID="seller-screen">
      <ListingResults
        filters={filters}
        onOpen={(listingId) => navigation.navigate('Listing', { listingId })}
        empty={{ title: `${s.displayName} has nothing for sale right now` }}
        header={
          <View style={styles.header}>
            <View style={styles.row}>
              <Icon name="storefront-outline" size={28} color="primary" />
              <Text variant="title" style={styles.flex}>
                {s.displayName}
              </Text>
            </View>
            {s.verified ? (
              <Text variant="caption" tone="success">
                ✓ Verified seller
              </Text>
            ) : null}
            {s.status !== 'active' ? (
              <Text tone="muted">
                {s.status === 'paused' ? 'This shop is taking a break.' : 'This shop is suspended.'}
              </Text>
            ) : null}
            {s.bio ? <Text>{s.bio}</Text> : null}
          </View>
        }
        testID="seller-listings"
      />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  header: { gap: t.spacing.xs, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));

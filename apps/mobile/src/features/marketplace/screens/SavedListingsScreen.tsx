import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { ListingResults } from '../components/ListingResults';

type Props = NativeStackScreenProps<CommunityStackParamList, 'SavedListings'>;

const SAVED = { favoritesOnly: true } as const;

/** The listings the user saved in the current community (still for sale). */
export function SavedListingsScreen({ navigation }: Props) {
  const styles = useStyles();
  return (
    <View style={styles.container} testID="saved-listings-screen">
      <ListingResults
        filters={SAVED}
        removeWhenUnsaved
        onOpen={(listingId) => navigation.navigate('Listing', { listingId })}
        empty={{ title: 'Nothing saved yet', message: 'Tap the heart on a listing to keep it here.' }}
        testID="saved-listings"
      />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
}));

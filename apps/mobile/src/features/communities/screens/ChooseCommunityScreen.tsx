import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components';
import { AuthNoticeBanner } from '@/features/auth/components/AuthNoticeBanner';
import { makeStyles } from '@/theme';
import { CommunityList } from '../components/CommunityList';

const NOTICES = ['emailConfirmed', 'passwordUpdated', 'linkError'] as const;

/** Home with no current community: pick one (or join one). */
export function ChooseCommunityScreen() {
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID="choose-community-screen">
      <CommunityList
        onSelected={() => {}}
        header={
          <>
            <Text variant="title" style={styles.title}>
              Your communities
            </Text>
            <AuthNoticeBanner only={NOTICES} />
          </>
        }
      />
    </SafeAreaView>
  );
}

const useStyles = makeStyles((t) => ({
  safe: { flex: 1, backgroundColor: t.colors.background },
  title: { paddingTop: t.spacing.sm },
}));

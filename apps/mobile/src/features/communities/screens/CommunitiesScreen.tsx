import { useNavigation } from '@react-navigation/native';
import { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import { errorMessage } from '@/utils/errors';

/** The community switcher: every community the user belongs to (services.communities.listMine). */
export function CommunitiesScreen() {
  const styles = useStyles();
  const navigation = useNavigation();
  const { communities } = useServices();
  const load = useCallback(() => communities.listMine(), [communities]);
  const mine = useAsync(load);

  if (mine.status === 'loading') return <LoadingState label="Loading your communities…" />;
  if (mine.status === 'error') return <ErrorState message={errorMessage(mine.error)} onRetry={mine.reload} />;

  const join = () => navigation.navigate('JoinCommunity');

  return (
    <Screen scroll={false} edges={['left', 'right']} testID="communities-screen">
      <FlatList
        data={mine.data}
        keyExtractor={(item) => item.community_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState
            icon="people-outline"
            title="No communities yet"
            message="Join a community with an invitation link, or create one."
            action={{ title: 'Join with an invitation', onPress: join }}
          />
        }
        renderItem={({ item }) => (
          <Card
            accessibilityLabel={`Open ${item.name}`}
            onPress={() =>
              navigation.navigate('Community', { communityId: item.community_id, name: item.name })
            }
          >
            <Text variant="heading">{item.name}</Text>
            <View style={styles.meta}>
              <Text variant="caption" tone="muted">
                {item.role_names.join(', ') || item.membership_status}
              </Text>
              {item.membership_status !== 'active' ? (
                <Text variant="caption" tone="danger">
                  {item.membership_status}
                </Text>
              ) : null}
            </View>
          </Card>
        )}
        ListFooterComponent={
          mine.data.length > 0 ? (
            <Button title="Join another community" variant="ghost" onPress={join} />
          ) : null
        }
      />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  list: { flexGrow: 1, gap: t.spacing.md, paddingVertical: t.spacing.lg },
  meta: { flexDirection: 'row', justifyContent: 'space-between' },
}));

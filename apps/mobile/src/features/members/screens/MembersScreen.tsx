import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, TextInput, View } from 'react-native';
import { Button, EmptyState, ErrorState, Icon, LoadingState, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { MemberItem } from '../MemberItem';
import { useMemberDirectory } from '../useMemberDirectory';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Members'>;

/** Wait this long after typing before searching. */
export const SEARCH_DELAY_MS = 300;

/**
 * The current community's member directory: active members by name, with a
 * name search. The server returns community-profile fields only (no phone
 * numbers or e-mail addresses), for this community only, and only to
 * members with members.view.
 */
export function MembersScreen({ navigation }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const { communities } = useServices();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const list = useMemberDirectory(community.community_id, query);
  const loadStats = useCallback(
    () => communities.stats(community.community_id),
    [communities, community.community_id],
  );
  const stats = useAsync(loadStats);
  const total = stats.status === 'success' ? stats.data.member_count : null;

  // Search once the user pauses typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Back from a profile: the server's current list.
  const { refresh } = list;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else void refresh();
    }, [refresh]),
  );

  return (
    <View style={styles.container} testID="members-screen">
      <View style={styles.top}>
        {total !== null ? (
          <Text variant="label" tone="muted" testID="members-count">
            {total === 1 ? '1 member' : `${total.toLocaleString()} members`}
          </Text>
        ) : null}
        <View style={styles.search}>
          <Icon name="search-outline" size={20} color="textMuted" />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={`Search ${community.name}`}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Search members by name"
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
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
      </View>
      {list.status === 'loading' ? (
        <LoadingState label="Loading members…" />
      ) : list.status === 'error' && list.items.length === 0 ? (
        <ErrorState
          title="Members could not be loaded"
          message={errorMessage(list.error)}
          onRetry={list.retry}
        />
      ) : (
        <FlatList
          testID="members-list"
          data={list.items}
          keyExtractor={(m) => m.userId}
          renderItem={({ item }) => (
            <MemberItem
              member={item}
              onPress={() => navigation.navigate('MemberProfile', { userId: item.userId })}
            />
          )}
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={() => void list.refresh()}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <EmptyState
              icon="people-outline"
              title={query ? `No members match “${query}”` : 'No members yet'}
              message={query ? 'Search looks at names only.' : undefined}
            />
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
                  title="Load more members"
                  variant="ghost"
                  loading={list.loadingMore}
                  onPress={list.loadMore}
                />
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  top: { gap: t.spacing.sm, padding: t.spacing.lg, paddingBottom: t.spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    minHeight: 48,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surfaceMuted,
  },
  input: { flex: 1, minHeight: 44, color: t.colors.text, fontSize: t.typography.body.fontSize },
  list: { flexGrow: 1 },
  footer: { alignItems: 'center', gap: t.spacing.sm, padding: t.spacing.md },
}));

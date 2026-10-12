import { useNavigation } from '@react-navigation/native';
import { useState, type ReactElement } from 'react';
import { FlatList, View } from 'react-native';
import { Banner, Button, EmptyState, ErrorState, LoadingState, TextField } from '@/components';
import { makeStyles } from '@/theme';
import { errorMessage } from '@/utils/errors';
import { useCurrentCommunity } from '../CurrentCommunityProvider';
import { filterCommunities } from '../selection';
import { CommunityCard } from './CommunityCard';
import { CommunityNoticeBanner } from './CommunityNoticeBanner';

/** The search field appears once a user has this many communities. */
export const SEARCH_MIN_COMMUNITIES = 4;

export interface CommunityListProps {
  /** Called after a community was selected (or the current one was tapped). */
  onSelected(): void;
  /** Shown above the list (e.g. a title). */
  header?: ReactElement;
  /** An error from outside the list to show at the top (e.g. a refused link). */
  error?: string | null;
}

/**
 * The user's communities as cards, with search and the current one marked.
 * Tapping a card selects it through useCurrentCommunity().select(), which
 * re-checks the user's memberships on the server first.
 */
export function CommunityList({ onSelected, header, error: outsideError }: CommunityListProps) {
  const styles = useStyles();
  const navigation = useNavigation();
  const { status, error, communities, current, select, retry } = useCurrentCommunity();
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  if (status === 'loading' || status === 'idle') return <LoadingState label="Loading your communities…" />;
  if (status === 'error') {
    return (
      <ErrorState
        title="Your communities could not be loaded"
        message={errorMessage(error)}
        onRetry={retry}
      />
    );
  }

  const choose = async (communityId: string) => {
    setSelectError(null);
    if (communityId === current?.community_id) {
      onSelected();
      return;
    }
    setSelecting(communityId);
    try {
      await select(communityId);
      onSelected();
    } catch (thrown) {
      setSelectError(errorMessage(thrown));
    } finally {
      setSelecting(null);
    }
  };

  const join = () => navigation.navigate('JoinCommunity');
  const visible = filterCommunities(communities, query);
  const shownError = selectError ?? outsideError;

  return (
    <FlatList
      data={visible}
      keyExtractor={(item) => item.community_id}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.header}>
          {header}
          <CommunityNoticeBanner />
          {shownError ? <Banner tone="danger" message={shownError} testID="community-select-error" /> : null}
          {communities.length >= SEARCH_MIN_COMMUNITIES ? (
            <TextField
              label="Search communities"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        communities.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="No communities yet"
            message="Join a community with an invitation, or create your own."
          />
        ) : (
          <EmptyState
            icon="search-outline"
            title="No matches"
            message={`No community matches “${query.trim()}”.`}
          />
        )
      }
      renderItem={({ item }) => (
        <CommunityCard
          community={item}
          current={item.community_id === current?.community_id}
          busy={selecting !== null}
          onPress={() => void choose(item.community_id)}
        />
      )}
      ListFooterComponent={
        <View style={styles.actions}>
          <Button title="Join with an invitation" variant="secondary" icon="enter-outline" onPress={join} />
          <Button
            title="Create a community"
            variant="ghost"
            icon="add-circle-outline"
            onPress={() => navigation.navigate('CreateCommunity')}
          />
        </View>
      }
    />
  );
}

const useStyles = makeStyles((t) => ({
  list: { flexGrow: 1, gap: t.spacing.md, padding: t.spacing.lg },
  header: { gap: t.spacing.md },
  actions: { gap: t.spacing.sm, paddingTop: t.spacing.sm },
}));

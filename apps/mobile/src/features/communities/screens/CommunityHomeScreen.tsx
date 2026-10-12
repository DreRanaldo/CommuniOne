import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useRef } from 'react';
import { RefreshControl, View } from 'react-native';
import { Banner, Button, EmptyState, ErrorState, LoadingState, Screen } from '@/components';
import { AuthNoticeBanner } from '@/features/auth/components/AuthNoticeBanner';
import { AlertCard } from '@/features/home/components/AlertCard';
import { AnnouncementItem } from '@/features/announcements/AnnouncementItem';
import { CommunityHeader } from '@/features/home/components/CommunityHeader';
import { EventCard } from '@/features/home/components/EventCard';
import { HomeSection } from '@/features/home/components/HomeSection';
import { PostCard } from '@/features/feed/components/PostCard';
import { QuickActions } from '@/features/home/components/QuickActions';
import { useCommunityHome } from '@/features/home/useCommunityHome';
import { makeStyles, useTheme } from '@/theme';
import type { CommunitySection, CommunityStackParamList } from '@/types/navigation';
import { errorMessage, isNetworkError } from '@/utils/errors';
import { formatTime } from '@/utils/format';
import { CommunityNoticeBanner } from '../components/CommunityNoticeBanner';
import { useCommunity } from '../CurrentCommunityProvider';

/**
 * The community's landing page, in priority order:
 *   1. active alerts (emergencies first)
 *   2. current announcements (important first)
 *   3. upcoming events
 *   4. recent activity (a few posts, not a feed)
 * then shortcuts to every section. Everything is for the current community
 * (useCommunity()); the stack is remounted when the community changes.
 */
export function CommunityHomeScreen({
  navigation,
}: NativeStackScreenProps<CommunityStackParamList, 'CommunityHome'>) {
  const styles = useStyles();
  const { colors } = useTheme();
  const community = useCommunity();
  const home = useCommunityHome(community.community_id);
  const open = (section: CommunitySection) => {
    if (section === 'feed') navigation.navigate('Feed');
    else if (section === 'announcements') navigation.navigate('Announcements');
    else navigation.navigate('CommunitySection', { section });
  };

  // Coming back to the home (e.g. from a section) refreshes it, keeping what is shown.
  const { refresh } = home;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else void refresh();
    }, [refresh]),
  );

  if (home.status === 'loading') return <LoadingState label={`Loading ${community.name}…`} />;
  if (home.status === 'error') {
    const offline = isNetworkError(home.error);
    return (
      <ErrorState
        title={offline ? "You're offline" : `${community.name} could not be loaded`}
        message={offline ? 'Check your connection and try again.' : errorMessage(home.error)}
        onRetry={home.retry}
      />
    );
  }

  const data = home.data!;
  const timeZone = data.details?.timezone;
  const quiet =
    data.alerts.items?.length === 0 &&
    data.announcements.items?.length === 0 &&
    data.events.items?.length === 0 &&
    data.posts.items?.length === 0;

  return (
    <Screen
      testID="community-home-screen"
      refreshControl={
        <RefreshControl
          refreshing={home.refreshing}
          onRefresh={() => void home.refresh()}
          tintColor={colors.primary}
          testID="home-refresh"
        />
      }
    >
      <AuthNoticeBanner only={['emailConfirmed', 'passwordUpdated', 'linkError']} />
      <CommunityNoticeBanner />
      {home.offline ? (
        <View style={styles.offline}>
          <Banner
            title="You're offline"
            message={`Showing what was loaded at ${formatTime(data.loadedAt)}.`}
            testID="home-offline"
          />
          <Button
            title="Try again"
            variant="secondary"
            fullWidth={false}
            onPress={() => void home.refresh()}
          />
        </View>
      ) : null}

      <CommunityHeader community={community} details={data.details} />

      {quiet ? (
        <EmptyState
          icon="leaf-outline"
          title={`It's quiet in ${community.name}`}
          message="There are no alerts, announcements, upcoming events or posts yet."
        />
      ) : (
        <>
          <HomeSection
            title="Alerts"
            icon="warning-outline"
            testID="home-alerts"
            result={data.alerts}
            empty="No active alerts."
            onSeeAll={() => open('alerts')}
            onRetry={() => void home.refresh()}
            renderItem={(alert) => <AlertCard key={alert.id} alert={alert} timeZone={timeZone} />}
          />
          <HomeSection
            title="Announcements"
            icon="megaphone-outline"
            testID="home-announcements"
            result={data.announcements}
            empty="No current announcements."
            onSeeAll={() => open('announcements')}
            onRetry={() => void home.refresh()}
            renderItem={(announcement) => (
              <AnnouncementItem
                key={announcement.id}
                announcement={announcement}
                compact
                onPress={() => navigation.navigate('AnnouncementDetail', { announcementId: announcement.id })}
              />
            )}
          />
          <HomeSection
            title="Upcoming events"
            icon="calendar-outline"
            testID="home-events"
            result={data.events}
            empty="No upcoming events."
            onSeeAll={() => open('events')}
            onRetry={() => void home.refresh()}
            renderItem={(event) => <EventCard key={event.id} event={event} />}
          />
          <HomeSection
            title="Recent activity"
            icon="chatbubbles-outline"
            testID="home-posts"
            result={data.posts}
            empty="No posts yet."
            onSeeAll={() => open('feed')}
            onRetry={() => void home.refresh()}
            renderItem={(post) => <PostCard key={post.id} post={post} compact />}
          />
        </>
      )}

      <QuickActions onOpen={open} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  offline: { gap: t.spacing.sm, alignItems: 'flex-start' },
}));

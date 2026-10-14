import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useRef } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { Banner, Button, EmptyState, ErrorState, Icon, LoadingState, Screen, Text } from '@/components';
import { hasAdminTools } from '@/features/admin/adminRules';
import { AuthNoticeBanner } from '@/features/auth/components/AuthNoticeBanner';
import { AlertCard } from '@/features/alerts/AlertCard';
import { AnnouncementItem } from '@/features/announcements/AnnouncementItem';
import { CommunityHero } from '@/features/home/components/CommunityHero';
import { SectionTiles } from '@/features/home/components/SectionTiles';
import { displayNameOf, useMyProfile } from '@/features/profile/hooks/useMyProfile';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { EventItem } from '@/features/events/EventItem';
import { HomeSection } from '@/features/home/components/HomeSection';
import { PostCard } from '@/features/feed/components/PostCard';
import { useCommunityHome } from '@/features/home/useCommunityHome';
import { makeStyles, useTheme } from '@/theme';
import type { CommunitySection, CommunityStackParamList } from '@/types/navigation';
import { errorMessage, isNetworkError } from '@/utils/errors';
import { formatTime } from '@/utils/format';
import { CommunityNoticeBanner } from '../components/CommunityNoticeBanner';
import { useCommunity } from '../CurrentCommunityProvider';
import { useCommunityPermissions } from '../useCommunityPermissions';

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
  // Root-level screens (switcher, Create): navigate bubbles up to the root stack.
  const rootNavigation = useNavigation();
  const home = useCommunityHome(community.community_id);
  const { communities } = useServices();
  const permissions = useCommunityPermissions();
  const loadStats = useCallback(
    () => communities.stats(community.community_id),
    [communities, community.community_id],
  );
  const stats = useAsync(loadStats);
  const profile = useMyProfile();
  const firstName =
    profile.status === 'success'
      ? profile.data.profile.first_name?.trim() ||
        displayNameOf(profile.data.profile)?.split(/\s+/)[0] ||
        null
      : null;
  const open = (section: CommunitySection) => {
    // The feed is the Home tab.
    if (section === 'feed') navigation.getParent()?.navigate('Home', { screen: 'Feed' });
    else if (section === 'announcements') navigation.navigate('Announcements');
    else if (section === 'alerts') navigation.navigate('Alerts');
    else if (section === 'events') navigation.navigate('Events');
    else if (section === 'documents') navigation.navigate('Documents');
    else navigation.navigate('Members');
  };

  // Coming back to the home (e.g. from a section) refreshes it, keeping what is shown.
  const { refresh } = home;
  const reloadStats = stats.reload;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else {
        void refresh();
        reloadStats();
      }
    }, [refresh, reloadStats]),
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
      edges={['top', 'left', 'right']}
      refreshControl={
        <RefreshControl
          refreshing={home.refreshing}
          onRefresh={() => {
            void home.refresh();
            stats.reload();
          }}
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

      <View style={styles.titleRow}>
        <View style={styles.flex}>
          <Text variant="caption" style={styles.eyebrow}>
            YOUR COMMUNITY
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Switch community. Current community: ${community.name}`}
            onPress={() => rootNavigation.navigate('Communities')}
            style={styles.switcher}
            hitSlop={6}
            testID="community-switcher"
          >
            <Text variant="display" style={styles.flexShrink} numberOfLines={2}>
              {community.name}
            </Text>
            <Icon name="chevron-down" size={22} color="textMuted" />
          </Pressable>
        </View>
        {hasAdminTools(permissions.can) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Admin tools"
            onPress={() => navigation.navigate('Admin')}
            style={styles.settings}
            hitSlop={6}
            testID="hub-admin"
          >
            <Icon name="shield-checkmark-outline" size={24} color="text" />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Community settings"
          onPress={() => navigation.navigate('CommunitySettings')}
          style={styles.settings}
          hitSlop={6}
          testID="hub-settings"
        >
          <Icon name="settings-outline" size={24} color="text" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create"
          onPress={() => rootNavigation.navigate('Create')}
          style={styles.create}
          hitSlop={6}
        >
          <Icon name="add" size={26} color="onPrimary" />
        </Pressable>
      </View>
      <Text tone="muted">
        {data.details?.description?.trim() || 'Everything happening in your community, all in one place.'}
      </Text>

      <CommunityHero
        community={community}
        details={data.details}
        firstName={firstName}
        memberCount={stats.status === 'success' ? stats.data.member_count : null}
        onManage={
          permissions.can('community.update') ? () => navigation.navigate('EditCommunity') : undefined
        }
      />

      <SectionTiles stats={stats.status === 'success' ? stats.data : null} onOpen={open} />

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
            renderItem={(alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                compact
                timeZone={timeZone}
                onPress={() => navigation.navigate('AlertDetail', { alertId: alert.id })}
              />
            )}
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
            renderItem={(event) => (
              <EventItem
                key={event.id}
                event={event}
                onPress={() => navigation.navigate('EventDetail', { eventId: event.id })}
              />
            )}
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
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  offline: { gap: t.spacing.sm, alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.md },
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  eyebrow: { color: t.colors.primary, fontWeight: '700', letterSpacing: 1.2 },
  switcher: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, minHeight: t.touchTarget },
  settings: {
    width: 52,
    height: 52,
    borderRadius: t.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surfaceMuted,
  },
  create: {
    width: 52,
    height: 52,
    borderRadius: t.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.primary,
  },
}));

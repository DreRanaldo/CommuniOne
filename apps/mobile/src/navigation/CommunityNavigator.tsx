import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { MyCommunity } from '@communione/services';
import { ErrorState, LoadingState } from '@/components';
import { CommunitySwitcherButton } from '@/features/communities/components/CommunitySwitcherButton';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { ChooseCommunityScreen } from '@/features/communities/screens/ChooseCommunityScreen';
import { CommunityHomeScreen } from '@/features/communities/screens/CommunityHomeScreen';
import { AlertDetailScreen } from '@/features/alerts/AlertDetailScreen';
import { AlertEditorScreen } from '@/features/alerts/AlertEditorScreen';
import { AlertsScreen } from '@/features/alerts/AlertsScreen';
import { EventDetailScreen } from '@/features/events/EventDetailScreen';
import { EventEditorScreen } from '@/features/events/EventEditorScreen';
import { EventsScreen } from '@/features/events/EventsScreen';
import { AnnouncementDetailScreen } from '@/features/announcements/AnnouncementDetailScreen';
import { AnnouncementEditorScreen } from '@/features/announcements/AnnouncementEditorScreen';
import { AnnouncementsScreen } from '@/features/announcements/AnnouncementsScreen';
import { PostDetailScreen } from '@/features/comments/PostDetailScreen';
import { FeedScreen } from '@/features/feed/screens/FeedScreen';
import { PostEditorScreen } from '@/features/feed/screens/PostEditorScreen';
import { PlaceholderScreen } from '@/screens/PlaceholderScreen';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<CommunityStackParamList>();

const SECTION_TITLES = {
  feed: 'Feed',
  announcements: 'Announcements',
  alerts: 'Alerts',
  events: 'Events',
  documents: 'Documents',
  members: 'Members',
} as const;

/**
 * The Home tab: the current community (from CurrentCommunityProvider, never
 * from a route parameter). With no community selected it shows the list to
 * choose one. Switching community remounts the stack, so no screen of the
 * previous community stays open.
 */
export function CommunityNavigator() {
  const { status, error, current, retry } = useCurrentCommunity();
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
  if (!current) return <ChooseCommunityScreen />;
  return <CommunityStack key={current.community_id} community={current} />;
}

function CommunityStack({ community }: { community: MyCommunity }) {
  const screenOptions = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="CommunityHome"
        component={CommunityHomeScreen}
        options={{
          title: community.name,
          headerTitle: () => <CommunitySwitcherButton community={community} />,
        }}
      />
      <Stack.Screen name="Feed" component={FeedScreen} options={{ title: 'Feed' }} />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: 'Post' }} />
      <Stack.Screen name="Events" component={EventsScreen} options={{ title: 'Events' }} />
      <Stack.Screen name="EventDetail" component={EventDetailScreen} options={{ title: 'Event' }} />
      <Stack.Screen
        name="EventEditor"
        component={EventEditorScreen}
        options={{ title: 'New event', presentation: 'modal' }}
      />
      <Stack.Screen name="Alerts" component={AlertsScreen} options={{ title: 'Alerts' }} />
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} options={{ title: 'Alert' }} />
      <Stack.Screen
        name="AlertEditor"
        component={AlertEditorScreen}
        options={{ title: 'New alert', presentation: 'modal' }}
      />
      <Stack.Screen
        name="Announcements"
        component={AnnouncementsScreen}
        options={{ title: 'Announcements' }}
      />
      <Stack.Screen
        name="AnnouncementDetail"
        component={AnnouncementDetailScreen}
        options={{ title: 'Announcement' }}
      />
      <Stack.Screen
        name="AnnouncementEditor"
        component={AnnouncementEditorScreen}
        options={{ title: 'New announcement', presentation: 'modal' }}
      />
      <Stack.Screen
        name="PostEditor"
        component={PostEditorScreen}
        options={{ title: 'New post', presentation: 'modal' }}
      />
      <Stack.Screen
        name="CommunitySection"
        component={PlaceholderScreen}
        options={({ route }) => ({ title: SECTION_TITLES[route.params.section] })}
      />
    </Stack.Navigator>
  );
}

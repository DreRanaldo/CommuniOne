import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { CommunityHomeScreen } from '@/features/communities/screens/CommunityHomeScreen';
import { PlaceholderScreen } from '@/screens/PlaceholderScreen';
import type { CommunityStackParamList, RootStackParamList } from '@/types/navigation';
import { CommunityProvider } from './CommunityContext';
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

/** Everything inside one community. The community id comes from the route, never from user input. */
export function CommunityNavigator({ route }: NativeStackScreenProps<RootStackParamList, 'Community'>) {
  const screenOptions = useStackOptions();
  const { communityId, name } = route.params;
  return (
    <CommunityProvider value={{ communityId, name }}>
      <Stack.Navigator screenOptions={screenOptions}>
        <Stack.Screen
          name="CommunityHome"
          component={CommunityHomeScreen}
          options={{ title: name ?? 'Community' }}
        />
        <Stack.Screen
          name="CommunitySection"
          component={PlaceholderScreen}
          options={({ route: r }) => ({ title: SECTION_TITLES[r.params.section] })}
        />
      </Stack.Navigator>
    </CommunityProvider>
  );
}

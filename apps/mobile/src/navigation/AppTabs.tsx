import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Icon, type IconName } from '@/components';
import { MarketplaceScreen } from '@/screens/MarketplaceScreen';
import type { AppTabParamList } from '@/types/navigation';
import { AlertsNavigator, CommunityHubNavigator, HomeNavigator } from './CommunityNavigator';
import { ProfileNavigator } from './ProfileNavigator';
import { useTabOptions } from './options';

const Tab = createBottomTabNavigator<AppTabParamList>();

const ICONS: Record<keyof AppTabParamList, [outline: IconName, filled: IconName]> = {
  Home: ['home-outline', 'home'],
  CommunitiesTab: ['people-outline', 'people'],
  Marketplace: ['storefront-outline', 'storefront'],
  AlertsTab: ['notifications-outline', 'notifications'],
  Profile: ['person-outline', 'person'],
};

/**
 * Home (the feed), Communities (the hub), Marketplace (placeholder), Alerts
 * and Profile. Home, Communities and Alerts all follow the current community.
 */
export function AppTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...tabOptions,
        tabBarIcon: ({ color, size, focused }) => (
          <Icon name={ICONS[route.name][focused ? 1 : 0]} color={color} size={size} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeNavigator} options={{ headerShown: false }} />
      <Tab.Screen
        name="CommunitiesTab"
        component={CommunityHubNavigator}
        options={{ headerShown: false, title: 'Communities' }}
      />
      <Tab.Screen name="Marketplace" component={MarketplaceScreen} />
      <Tab.Screen
        name="AlertsTab"
        component={AlertsNavigator}
        options={{ headerShown: false, title: 'Alerts' }}
      />
      <Tab.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Icon, type IconName } from '@/components';
import { NotificationsScreen } from '@/features/notifications/screens/NotificationsScreen';
import { CommunityNavigator } from './CommunityNavigator';
import { ProfileNavigator } from './ProfileNavigator';
import type { AppTabParamList } from '@/types/navigation';
import { useTabOptions } from './options';

const Tab = createBottomTabNavigator<AppTabParamList>();

const ICONS: Record<keyof AppTabParamList, IconName> = {
  Home: 'home-outline',
  Notifications: 'notifications-outline',
  Profile: 'person-circle-outline',
};

export function AppTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...tabOptions,
        tabBarIcon: ({ color, size }) => <Icon name={ICONS[route.name]} color={color} size={size} />,
      })}
    >
      <Tab.Screen name="Home" component={CommunityNavigator} options={{ headerShown: false }} />
      <Tab.Screen name="Notifications" component={NotificationsScreen} />
      <Tab.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Icon, type IconName } from '@/components';
import { CommunitiesScreen } from '@/features/communities/screens/CommunitiesScreen';
import { NotificationsScreen } from '@/features/notifications/screens/NotificationsScreen';
import { ProfileNavigator } from './ProfileNavigator';
import type { AppTabParamList } from '@/types/navigation';
import { useTabOptions } from './options';

const Tab = createBottomTabNavigator<AppTabParamList>();

const ICONS: Record<keyof AppTabParamList, IconName> = {
  Communities: 'people-outline',
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
      <Tab.Screen name="Communities" component={CommunitiesScreen} />
      <Tab.Screen name="Notifications" component={NotificationsScreen} />
      <Tab.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}

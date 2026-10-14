import {
  BottomTabBar,
  createBottomTabNavigator,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import { Pressable, View } from 'react-native';
import { Icon, type IconName } from '@/components';
import { DiscoverScreen } from '@/features/discover/DiscoverScreen';
import { makeStyles } from '@/theme';
import type { AppTabParamList } from '@/types/navigation';
import { CommunityHubNavigator, HomeNavigator, MarketNavigator } from './CommunityNavigator';
import { ProfileNavigator } from './ProfileNavigator';
import { useTabOptions } from './options';

const Tab = createBottomTabNavigator<AppTabParamList>();

const ICONS: Record<keyof AppTabParamList, [outline: IconName, filled: IconName]> = {
  Home: ['home-outline', 'home'],
  CommunitiesTab: ['people-outline', 'people'],
  Discover: ['compass-outline', 'compass'],
  Marketplace: ['bag-handle-outline', 'bag-handle'],
  Profile: ['person-circle-outline', 'person-circle'],
};

/** Tabs whose main screen shows the floating "+" (creating belongs to the community). */
const CREATE_TABS = new Set<keyof AppTabParamList>(['Home', 'CommunitiesTab', 'Discover']);

/** The floating blue "+" (Create): bottom right, just above the tab bar. */
function CreateButton() {
  const styles = useStyles();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Create"
      onPress={() => navigation.navigate('Create')}
      style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
      hitSlop={6}
      testID="fab-create"
    >
      <Icon name="add" size={30} color="onPrimary" />
    </Pressable>
  );
}

/**
 * The standard tab bar with the floating "+" above it. The button shows on
 * the main screen of Home, Communities and Discover only, so it never covers
 * a post, an editor or a detail screen.
 */
function TabBarWithCreate(props: BottomTabBarProps) {
  const styles = useStyles();
  const route = props.state.routes[props.state.index]!;
  const nestedIndex = (route.state as { index?: number } | undefined)?.index ?? 0;
  const show = CREATE_TABS.has(route.name as keyof AppTabParamList) && nestedIndex === 0;
  return (
    <View>
      {show ? (
        <View style={styles.anchor} pointerEvents="box-none">
          <CreateButton />
        </View>
      ) : null}
      <BottomTabBar {...props} />
    </View>
  );
}

/**
 * Home (the feed), Communities (the hub), Discover, Market (placeholder) and
 * Profile, with a floating "+" (Create) above the bar. Home and Communities
 * follow the current community; alerts open from the hub, the feed and
 * notifications.
 */
export function AppTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tab.Navigator
      tabBar={(props) => <TabBarWithCreate {...props} />}
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
      <Tab.Screen name="Discover" component={DiscoverScreen} options={{ headerShown: false }} />
      <Tab.Screen
        name="Marketplace"
        component={MarketNavigator}
        options={{ headerShown: false, title: 'Market' }}
      />
      <Tab.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}

const useStyles = makeStyles((t) => ({
  // Sits on top of the tab bar, anchored to its top-right corner.
  anchor: {
    position: 'absolute',
    right: t.spacing.lg,
    bottom: '100%',
    marginBottom: t.spacing.lg,
    zIndex: 10,
  },
  fab: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.primary,
    shadowColor: t.colors.primary,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pressed: { backgroundColor: t.colors.primaryPressed },
}));

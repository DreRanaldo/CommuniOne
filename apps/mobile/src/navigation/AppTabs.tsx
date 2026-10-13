import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import { Pressable, View } from 'react-native';
import { Icon, type IconName } from '@/components';
import { DiscoverScreen } from '@/features/discover/DiscoverScreen';
import { MarketplaceScreen } from '@/screens/MarketplaceScreen';
import { makeStyles } from '@/theme';
import type { AppTabParamList } from '@/types/navigation';
import { CommunityHubNavigator, HomeNavigator } from './CommunityNavigator';
import { ProfileNavigator } from './ProfileNavigator';
import { useTabOptions } from './options';

const Tab = createBottomTabNavigator<AppTabParamList>();

const ICONS: Record<Exclude<keyof AppTabParamList, 'CreateTab'>, [outline: IconName, filled: IconName]> = {
  Home: ['home-outline', 'home'],
  CommunitiesTab: ['people-outline', 'people'],
  Discover: ['compass-outline', 'compass'],
  Marketplace: ['bag-handle-outline', 'bag-handle'],
  Profile: ['person-circle-outline', 'person-circle'],
};

/** Never shown: the centre tab only opens the Create sheet. */
const Nothing = () => null;

/** The raised blue "+" in the middle of the tab bar. */
function CreateButton() {
  const styles = useStyles();
  const navigation = useNavigation();
  return (
    <View style={styles.slot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create"
        onPress={() => navigation.navigate('Create')}
        style={({ pressed }) => [styles.create, pressed && styles.pressed]}
        testID="tab-create"
      >
        <Icon name="add" size={30} color="onPrimary" />
      </Pressable>
    </View>
  );
}

/**
 * Home (the feed), Communities (the hub), Discover, the centre "+" (Create),
 * Market (placeholder) and Profile. Home and Communities follow the current
 * community; alerts open from the hub, the feed and notifications.
 */
export function AppTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...tabOptions,
        tabBarIcon: ({ color, size, focused }) =>
          route.name === 'CreateTab' ? null : (
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
        name="CreateTab"
        component={Nothing}
        options={{ title: 'Create', tabBarButton: () => <CreateButton /> }}
      />
      <Tab.Screen name="Marketplace" component={MarketplaceScreen} options={{ title: 'Market' }} />
      <Tab.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}

const useStyles = makeStyles((t) => ({
  slot: { flex: 1, alignItems: 'center' },
  create: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginTop: -14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.primary,
    shadowColor: t.colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pressed: { backgroundColor: t.colors.primaryPressed },
}));

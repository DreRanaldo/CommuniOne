import { StackActions, type NavigationProp } from '@react-navigation/native';
import type { AppTabParamList, CommunityStackParamList, RootStackParamList } from '@/types/navigation';

export type CommunityTab = Extract<keyof AppTabParamList, 'Home' | 'CommunitiesTab' | 'Marketplace'>;

/**
 * From a root-level screen (notification center, Create sheet), back to the
 * existing tabs and into a screen of the current community. popTo, because
 * navigate would stack a second copy of the tabs (React Navigation 7).
 */
export function openInCommunity<S extends keyof CommunityStackParamList>(
  navigation: NavigationProp<RootStackParamList>,
  tab: CommunityTab,
  screen: S,
  params?: CommunityStackParamList[S],
) {
  navigation.dispatch(
    StackActions.popTo('App', { screen: tab, params: { screen, params, initial: false } } as never),
  );
}

// Deep links: communione://join?token=… opens the Join modal (invitations);
// communione://communities opens the switcher, and communione://communities/<id>
// asks to switch (validated against the user's memberships before use);
// communione://notifications opens the notification center and
// communione://notifications/<id> one notification (read from the server: owner only).
import type { LinkingOptions } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { isAuthLink, URL_SCHEME } from '@/constants/app';
import type { RootStackParamList } from '@/types/navigation';

/** The runtime URL prefix (e.g. exp://… in Expo Go); absent when no manifest is available. */
function runtimePrefix(): string[] {
  try {
    return [Linking.createURL('/')];
  } catch {
    return [];
  }
}

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [...new Set([`${URL_SCHEME}://`, ...runtimePrefix()])],
  // Email links (auth/callback, auth/reset-password) are completed by the
  // AuthProvider, never routed: they carry one-time codes.
  filter: (url) => !isAuthLink(url),
  config: {
    screens: {
      JoinCommunity: 'join',
      Communities: 'communities/:communityId?',
      Notifications: 'notifications',
      NotificationDetail: 'notifications/:notificationId',
      App: {
        screens: {
          Home: 'home',
          // The alerts list lives in the hub; communione://alerts still opens it.
          CommunitiesTab: { path: 'community', screens: { Alerts: { path: 'alerts', exact: true } } },
          Discover: 'discover',
          Marketplace: 'marketplace',
          Profile: { path: 'profile', screens: { ProfileHome: '' } },
        },
      },
    },
  },
};

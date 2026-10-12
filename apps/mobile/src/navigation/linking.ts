// Deep links: communione://join?token=… opens the Join modal (invitations).
import type { LinkingOptions } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { URL_SCHEME } from '@/constants/app';
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
  config: {
    screens: {
      JoinCommunity: 'join',
      App: {
        screens: {
          Communities: 'communities',
          Notifications: 'notifications',
          Profile: 'profile',
        },
      },
    },
  },
};

// Incoming deep links (the URL that opened the app, and later ones), behind a
// small interface so tests can supply links without a device.
import * as Linking from 'expo-linking';

export interface LinkSource {
  getInitialURL(): Promise<string | null>;
  subscribe(listener: (url: string) => void): () => void;
}

export const expoLinkSource: LinkSource = {
  getInitialURL: () => Linking.getInitialURL(),
  subscribe(listener) {
    const subscription = Linking.addEventListener('url', ({ url }) => listener(url));
    return () => subscription.remove();
  },
};

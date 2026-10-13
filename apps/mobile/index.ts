// PKCE needs WebCrypto (S256): installed before anything else is imported.
import './src/lib/polyfills';

import { registerRootComponent } from 'expo';

import App from './src/App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets up the environment for Expo Go and native builds alike.
registerRootComponent(App);

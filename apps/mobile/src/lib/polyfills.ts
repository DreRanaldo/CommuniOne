// Side effects only. Imported first by index.ts, before any module that may
// create the Supabase client (imports run in order).
import { installWebCrypto } from './webCrypto';

installWebCrypto();

// Runs before each test file, after the test framework is installed.
import * as SecureStore from 'expo-secure-store';

// Every test starts with an empty keychain (no session, no stored community).
beforeEach(() => (SecureStore as unknown as { __store: Map<string, string> }).__store.clear());

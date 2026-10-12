// ESLint flat config: Expo's recommended rules, with formatting left to Prettier.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['dist/*', 'coverage/*', '.expo/*', 'expo-env.d.ts'],
  },
  {
    rules: {
      // Never use console.* directly in app code: go through the redacting logger.
      'no-console': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Node-side files (tooling and build scripts).
    files: ['scripts/**', '*.config.js', '*.config.ts', 'jest.setup.ts'],
    languageOptions: {
      globals: { __dirname: 'readonly', require: 'readonly', module: 'writable', process: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
]);

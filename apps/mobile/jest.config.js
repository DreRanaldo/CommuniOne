// Jest: the jest-expo preset (React Native environment, Babel via Expo's preset).
const path = require('node:path');

module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.afterEnv.ts'],
  testMatch: ['<rootDir>/src/**/*.test.ts?(x)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@communione/services$': path.resolve(__dirname, '../../services/index.ts'),
  },
  // The shared service layer lives outside this folder; transform it too.
  roots: ['<rootDir>', path.resolve(__dirname, '../../services')],
  // Shared code outside this folder resolves packages from this app's node_modules (as Metro does).
  moduleDirectories: ['node_modules', path.resolve(__dirname, 'node_modules')],
  clearMocks: true,
};

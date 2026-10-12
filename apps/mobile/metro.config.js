// Metro configuration: Expo defaults, plus the repository's shared service
// layer (../../services), which lives outside this app's folder.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const servicesRoot = path.resolve(projectRoot, '../../services');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), servicesRoot];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@communione/services': servicesRoot,
};
// Shared code resolves packages from this app's node_modules only, so the app
// never bundles a second copy of a dependency from the repository root.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;

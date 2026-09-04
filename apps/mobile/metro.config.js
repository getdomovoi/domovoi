const { getDefaultConfig } = require("expo/metro-config")
const { withNativeWind } = require("nativewind/metro")
const path = require("node:path")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "../..")

const config = getDefaultConfig(projectRoot)

// The app lives in a pnpm workspace, so Metro has to be told where the shared
// packages are. Without both roots it resolves @getdomovoi/protocol to nothing.
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]
// pnpm keeps real packages in a content-addressed store and links them, so
// Metro has to be allowed to walk up into it. Disabling hierarchical lookup,
// which is the usual monorepo advice, makes expo's own dependencies unresolvable.
config.resolver.unstable_enableSymlinks = true

module.exports = withNativeWind(config, { input: "./src/global.css" })

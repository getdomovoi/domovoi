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
config.resolver.disableHierarchicalLookup = true

module.exports = withNativeWind(config, { input: "./src/global.css" })

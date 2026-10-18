const fs = require("node:fs")
const path = require("node:path")
const { withDangerousMod } = require("expo/config-plugins")

// babel.config.js names babel-preset-expo, which comes with expo rather than as a dependency
// of this app, and nativewind's preset names @babel/plugin-transform-react-jsx, which it does
// not depend on. Babel resolves both from this directory, and pnpm's isolated layout puts
// them only in node_modules/.pnpm/node_modules. pnpm's bin shims add that directory to
// NODE_PATH, so `expo` commands find them, but Xcode's "Bundle React Native code and images"
// phase runs @expo/cli with plain node, and a Release build from xcodebuild or the Xcode app
// fails there. Every Xcode script phase sources ios/.xcode.env, so it gets the same entry.
const MARKER = "# Written by plugins/with-pnpm-node-path.js: the packages pnpm hoists for its bin shims."

module.exports = function withPnpmNodePath(config) {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      const expoPackage = fs.realpathSync(require.resolve("expo/package.json", { paths: [config.modRequest.projectRoot] }))
      const store = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`
      const at = expoPackage.lastIndexOf(store)
      if (at === -1) return config
      const hoisted = path.join(expoPackage.slice(0, at + store.length), "node_modules")
      const file = path.join(config.modRequest.platformProjectRoot, ".xcode.env")
      // A prebuild without --clean runs this again on the same file, so replace the block.
      const kept = fs.readFileSync(file, "utf8").split(MARKER)[0].trimEnd()
      const quoted = `'${hoisted.replaceAll("'", "'\\''")}'`
      fs.writeFileSync(file, `${kept}\n\n${MARKER}\nexport NODE_PATH=${quoted}\${NODE_PATH:+:$NODE_PATH}\n`)
      return config
    },
  ])
}

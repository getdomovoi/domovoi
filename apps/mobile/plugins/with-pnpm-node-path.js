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
const BEGIN = "# BEGIN plugins/with-pnpm-node-path.js: the packages pnpm hoists for its bin shims"
const END = "# END plugins/with-pnpm-node-path.js"

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
      const quoted = `'${hoisted.replaceAll("'", "'\\''")}'`
      const block = `${BEGIN}\nexport NODE_PATH=${quoted}\${NODE_PATH:+:$NODE_PATH}\n${END}\n`
      // A prebuild without --clean runs this again on the same file: replace only the block.
      const current = fs.readFileSync(file, "utf8")
      const start = current.indexOf(BEGIN)
      const end = start === -1 ? -1 : current.indexOf(END, start)
      const next =
        end === -1
          ? `${current.trimEnd()}\n\n${block}`
          : `${current.slice(0, start)}${block}${current.slice(end + END.length).replace(/^\n/, "")}`
      fs.writeFileSync(file, next)
      return config
    },
  ])
}

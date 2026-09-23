import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const desktopRoot = fileURLToPath(new URL("../apps/desktop/", import.meta.url))
const desktopRequire = createRequire(join(desktopRoot, "package.json"))
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"))
const { getConfig } = builderRequire("app-builder-lib/out/util/config/config.js")
const { FileMatcher, getNodeModuleFileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js")

const sdkName = "@anthropic-ai/claude-agent-sdk"

function sdkManifest() {
  const daemonRequire = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
  let directory = dirname(daemonRequire.resolve(sdkName))
  for (;;) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
    if (manifest.name === sdkName) return manifest
    directory = dirname(directory)
  }
}

async function effectiveConfig() {
  const keys = Object.keys(process.env).filter((key) => /^(CSC_|WIN_CSC_|APPLE_|AZURE_|DOMOVOI_DESKTOP_REQUIRE_SIGNING$|DOMOVOI_WIN_PUBLISHER_NAME$)/u.test(key))
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    return await getConfig(desktopRoot, join(desktopRoot, "electron-builder.cjs"))
  } finally {
    Object.assign(process.env, previous)
  }
}

// The same matcher electron-builder applies to each production dependency it
// copies into the app, judged on the path the file would have inside it.
function packagedFilter(config, platformOptions) {
  const identity = (value) => value
  const excludes = getNodeModuleFileMatcher(desktopRoot, "/app", identity, platformOptions ?? {}, {
    config,
    debugLogger: { isEnabled: false },
  })
  const filter = new FileMatcher("/source", "/app", identity, excludes.patterns).createFilter()
  return (path) => filter(`/source/${path}`, { isDirectory: () => false, moduleFullFilePath: path })
}

test("the desktop app ships the SDK library and none of its agent binaries", async () => {
  const config = await effectiveConfig()
  const platformPackages = Object.keys(sdkManifest().optionalDependencies ?? {})
  assert.ok(platformPackages.length > 0, "the SDK names its per-platform agent packages")
  for (const platform of ["mac", "linux", "win"]) {
    const packaged = packagedFilter(config, config[platform])
    assert.equal(packaged(`node_modules/${sdkName}/sdk.mjs`), true, `${platform} keeps the SDK library`)
    for (const name of platformPackages) {
      for (const path of [
        `node_modules/${name}/claude`,
        `node_modules/${name}/claude.exe`,
        `node_modules/${name}/package.json`,
        `node_modules/@getdomovoi/daemon/node_modules/${name}/claude`,
      ]) {
        assert.equal(packaged(path), false, `${platform} excludes ${path}`)
      }
    }
  }
})

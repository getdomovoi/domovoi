import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const desktopRoot = fileURLToPath(new URL("../apps/desktop/", import.meta.url))
const desktopRequire = createRequire(join(desktopRoot, "package.json"))
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"))
const { getConfig } = builderRequire("app-builder-lib/out/util/config/config.js")
const { FileMatcher, getFileMatchers, getNodeModuleFileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js")
const { getCollectorByPackageManager, PM } = builderRequire("app-builder-lib/out/node-module-collector/index.js")
const { TmpDir } = builderRequire("temp-file")

const sdkName = "@anthropic-ai/claude-agent-sdk"
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

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

// Every package electron-builder would copy into app.asar, by the same
// collector it runs, before the files exclusions apply.
async function productionTree(directory, packageName) {
  const temporary = new TmpDir()
  try {
    const collector = getCollectorByPackageManager(PM.PNPM, join(repositoryRoot, directory), temporary)
    const { nodeModules } = await collector.getNodeModules({ packageName })
    const names = new Set()
    const visit = (modules) => { for (const module of modules) { names.add(module.name); visit(module.dependencies ?? []) } }
    visit(nodeModules)
    return names
  } finally {
    await temporary.cleanup()
  }
}

// Vite inlines the renderer into out/renderer, so a package only the renderer
// uses would sit unused in node_modules. The main process's own graph, the
// daemon and the credential store, may share a package with the renderer.
test("the desktop app copies no package that only the renderer bundle uses", { timeout: 60_000 }, async () => {
  const { rendererBundlePackages } = await import("./renderer-bundle-packages.mjs")
  const packaged = await productionTree("apps/desktop", "@getdomovoi/desktop")
  const mainSide = new Set([
    ...await productionTree("apps/daemon", "@getdomovoi/daemon"),
    ...await productionTree("packages/credential-store", "@getdomovoi/credential-store"),
  ])
  const rendererOnly = ["@getdomovoi/ui", ...await rendererBundlePackages(repositoryRoot)].filter((name) => !mainSide.has(name))
  assert.ok(rendererOnly.includes("react") && rendererOnly.includes("lucide-react"), "the renderer bundle is read")
  assert.deepEqual(rendererOnly.filter((name) => packaged.has(name)), [], "renderer-only packages electron-builder would copy")
})

// electron-builder deletes Electron's LICENSE and LICENSES.chromium.html from a
// macOS bundle and keeps them beside the executable on Linux and Windows. The
// notices for the bundled graph ship on every platform.
test("every desktop build carries the notices for the software it bundles", async () => {
  const config = await effectiveConfig()
  const { desktopNoticesDirectory } = await import("./third-party-notices.mjs")
  const manifest = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"))
  assert.match(manifest.scripts.prepackage, /third-party-notices\.mjs/u, "packaging writes the notices first")
  const resources = "/resources"
  for (const [platform, expected] of [
    ["mac", ["THIRD_PARTY_NOTICES.txt", "LICENSE.electron.txt", "LICENSES.chromium.html"]],
    ["linux", ["THIRD_PARTY_NOTICES.txt"]],
    ["win", ["THIRD_PARTY_NOTICES.txt"]],
  ]) {
    const matchers = getFileMatchers(config, "extraResources", resources, {
      defaultSrc: desktopRoot, customBuildOptions: config[platform] ?? {}, macroExpander: (value) => value,
      globalOutDir: join(desktopRoot, "dist"),
    }) ?? []
    const copied = new Map(matchers.map((matcher) => [relative(resources, matcher.to), relative(desktopRoot, matcher.from)]))
    for (const file of expected) {
      assert.equal(copied.get(file), join(relative(desktopRoot, join(fileURLToPath(new URL("../", import.meta.url)), desktopNoticesDirectory)), file),
        `${platform} copies ${file} from the generated notices`)
    }
  }
})

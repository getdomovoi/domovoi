import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { desktopPackages } from "./dependency-licenses.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

// Each production dependency is installed with the package, so it has to be
// loaded by the code that ships. Tests and type-only imports do not count.
// Desktop's shipped Node code is the main process and the preload, with the
// modules they share. The renderer is left out: vite inlines everything it
// imports into out/renderer, so none of it is loaded from node_modules.
const packages = [
  { directory: "apps/cli", sources: ["src"] },
  { directory: "apps/desktop", sources: ["src/main", "src/preload", "src/shared"] },
]

const moduleSpecifier = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

async function runtimeImports(root, sources) {
  const names = new Set()
  for (const source of sources) {
    for (const file of await sourceFiles(join(root, source))) {
      const text = await readFile(file, "utf8")
      for (const match of text.matchAll(moduleSpecifier)) {
        if (match[1]) continue
        const name = packageName(match[2] ?? match[3])
        if (name) names.add(name)
      }
    }
  }
  return names
}

for (const { directory, sources } of packages) {
  test(`${directory} declares only dependencies its shipped code loads`, async () => {
    const root = join(repositoryRoot, directory)
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    const loaded = await runtimeImports(root, sources)
    const unused = Object.keys(manifest.dependencies ?? {}).filter((name) => !loaded.has(name))
    assert.deepEqual(unused, [], `${directory} declares dependencies nothing in ${sources.join(", ")} loads`)
  })
}

// The converse for the desktop app. electron-vite leaves `dependencies` in
// node_modules and bundles every other import into out/, so a third-party
// package moved to devDependencies would still load but leave the production
// graph the license audit and the notices read. Electron and Node's builtins
// come from the runtime. Workspace packages are bundled or, like the daemon
// since #577, shipped beside the archive; either way desktopPackages names
// them, and scripts/dependency-licenses.test.mjs checks that list.
test("apps/desktop declares every third-party package its shipped code loads", async () => {
  const root = join(repositoryRoot, "apps/desktop")
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const loaded = [...await runtimeImports(root, ["src/main", "src/preload", "src/shared"])]
  const workspace = loaded.filter((name) => name.startsWith("@getdomovoi/"))
  assert.deepEqual(workspace.filter((name) => !desktopPackages.includes(name)), [], "workspace packages the license audit does not name")
  const undeclared = loaded.filter((name) => !name.startsWith("@getdomovoi/") && name !== "electron"
    && !builtinModules.includes(name) && !Object.hasOwn(manifest.dependencies ?? {}, name))
  assert.deepEqual(undeclared, [], "apps/desktop loads third-party packages outside its dependencies")
})

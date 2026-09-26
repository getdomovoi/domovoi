import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

// Each production dependency is installed with the package, so it has to be
// loaded by the code that ships. Tests and type-only imports do not count.
const packages = [
  { directory: "apps/cli", sources: ["src"] },
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

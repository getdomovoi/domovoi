import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)))

// A bundled file belongs to the package under its last node_modules segment.
// pnpm keeps each package at node_modules/.pnpm/<id>/node_modules/<name>.
export function packageOfModule(id) {
  const path = id.replace(/^\0/u, "").replaceAll("\\", "/")
  const index = path.lastIndexOf("/node_modules/")
  if (index === -1) return undefined
  const [scope, name] = path.slice(index + "/node_modules/".length).split("/")
  if (!scope || scope.startsWith(".")) return undefined
  return scope.startsWith("@") ? (name ? `${scope}/${name}` : undefined) : scope
}

// Builds the desktop renderer as packaging does, without writing it, and names
// every npm package with a module or an emitted asset in the result. Fonts
// arrive as assets from CSS url(), so chunk modules alone would miss them.
export async function rendererBundlePackages(root = repositoryRoot) {
  const desktopRoot = join(root, "apps/desktop")
  const desktopRequire = createRequire(join(desktopRoot, "package.json"))
  const { resolveConfig } = await import(pathToFileURL(desktopRequire.resolve("electron-vite")).href)
  const { build } = await import(pathToFileURL(desktopRequire.resolve("vite")).href)
  const outDir = await mkdtemp(join(tmpdir(), "domovoi-renderer-"))
  const packages = new Set()
  try {
    const { config } = await resolveConfig({
      root: desktopRoot, logLevel: "silent", build: { outDir, write: false, emptyOutDir: false },
    }, "build", "production")
    if (!config?.renderer) throw new Error("apps/desktop has no renderer build")
    // electron-vite resolves the renderer root against the working directory.
    config.renderer.root ??= join(desktopRoot, "src/renderer")
    config.renderer.plugins = [...(config.renderer.plugins ?? []), {
      name: "domovoi:renderer-bundle-packages",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          const sources = output.type === "chunk" ? output.moduleIds : output.originalFileNames ?? []
          for (const source of sources) {
            const name = packageOfModule(source)
            if (name) packages.add(name)
          }
        }
      },
    }]
    await build(config.renderer)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
  return [...packages].sort()
}

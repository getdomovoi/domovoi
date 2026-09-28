import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
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

const cssComment = /\/\*[\s\S]*?\*\//gu
const cssImport = /@import\s+(?:url\(\s*)?["']([^"']+)["']/gu

// The specifiers a stylesheet names in @import rules, comments removed.
export function cssImportSpecifiers(text) {
  return [...text.replace(cssComment, "").matchAll(cssImport)].map((match) => match[1])
}

// @tailwindcss/vite resolves a stylesheet's @import rules itself and inlines
// what they name, so those files never become bundle modules. This follows the
// rules from each bundled stylesheet, through the stylesheets they reach, and
// names the package every resolved import belongs to. Tailwind's own preflight
// and generated CSS arrive through @import "tailwindcss". The resolver takes
// the options @tailwindcss/vite gives its own stylesheet resolver.
async function cssImportPackages(config, stylesheets) {
  const resolveStylesheet = config.createResolver({
    ...config.resolve, extensions: [".css"], mainFields: ["style"],
    conditions: ["style", "development|production"], tryIndex: false, preferRelative: true,
  })
  const packages = new Set()
  const seen = new Set()
  const pending = [...stylesheets]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of cssImportSpecifiers(await readFile(file, "utf8"))) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(specifier)) continue
      const resolved = await resolveStylesheet(specifier, file)
      if (!resolved) throw new Error(`${file} imports ${specifier}, which the renderer build cannot resolve`)
      const path = resolved.split("?")[0]
      const name = packageOfModule(path)
      if (name) packages.add(name)
      if (path.endsWith(".css")) pending.push(path)
    }
  }
  return packages
}

// Builds the desktop renderer as packaging does, without writing it, and names
// every npm package with a module or an emitted asset in the result. Fonts
// arrive as assets from CSS url(), so chunk modules alone would miss them, and
// CSS that Tailwind inlines through @import is found by following those rules.
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
    let resolvedConfig
    config.renderer.plugins = [...(config.renderer.plugins ?? []), {
      name: "domovoi:renderer-bundle-packages",
      configResolved(value) { resolvedConfig = value },
      async generateBundle(_options, bundle) {
        const stylesheets = new Set()
        for (const output of Object.values(bundle)) {
          const sources = output.type === "chunk" ? output.moduleIds : output.originalFileNames ?? []
          for (const source of sources) {
            const name = packageOfModule(source)
            if (name) packages.add(name)
            const file = source.replace(/^\0/u, "").split("?")[0]
            if (file.endsWith(".css") && isAbsolute(file)) stylesheets.add(file)
          }
        }
        for (const name of await cssImportPackages(resolvedConfig, stylesheets)) packages.add(name)
      },
    }]
    await build(config.renderer)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
  return [...packages].sort()
}

import { readFile, readdir } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")

async function sumExtensions(root, extensions) {
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) total += await sumExtensions(path, extensions)
    else if (entry.isFile() && extensions.has(extname(entry.name))) {
      total += (await readFile(path)).byteLength
    }
  }
  return total
}

function startupScriptReferences(html) {
  const references = []
  for (const match of html.matchAll(/<script\b[^>]*>/g)) {
    const tag = match[0]
    if (!/\btype\s*=\s*"module"/.test(tag)) continue
    const source = /\bsrc\s*=\s*"([^"]+)"/.exec(tag)
    if (source) references.push(source[1])
  }
  for (const match of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0]
    if (!/\brel\s*=\s*"modulepreload"/.test(tag)) continue
    const href = /\bhref\s*=\s*"([^"]+)"/.exec(tag)
    if (href) references.push(href[1])
  }
  return references
}

async function startupScripts(indexHtmlPath) {
  const html = await readFile(indexHtmlPath, "utf8")
  const root = dirname(indexHtmlPath)
  const paths = new Set()
  let total = 0
  for (const reference of new Set(startupScriptReferences(html))) {
    const path = reference.startsWith("/")
      ? join(root, reference.slice(1))
      : resolve(root, reference)
    paths.add(path)
    total += (await readFile(path)).byteLength
  }
  return { paths, total }
}

async function scriptFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await scriptFiles(path))
    else if (entry.isFile() && [".js", ".mjs"].includes(extname(entry.name))) files.push(path)
  }
  return files
}

// Static imports between built chunks: `import ... from "./x.js"` and the bare
// `import "./x.js"`. A dynamic `import("./x.js")` is a separate lazy load and is
// not followed.
function staticImports(source) {
  const found = []
  for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.m?js)["']/g)) found.push(match[1])
  return found
}

// A lazy chunk is paid for only when the surface that needs it opens, so each
// one is held to the ceiling on its own, together with every chunk it imports
// that startup did not already load: a surface split across several chunks is
// still one download when it opens. A sum over all lazy chunks would charge
// each surface for every other one and push splitting back into startup.
async function largestLazyGraph(root, startup) {
  const sizes = new Map()
  const imports = new Map()
  for (const path of await scriptFiles(root)) {
    const source = await readFile(path, "utf8")
    sizes.set(path, Buffer.byteLength(source))
    imports.set(path, staticImports(source).map((reference) => resolve(dirname(path), reference)))
  }
  let largest = 0
  for (const path of sizes.keys()) {
    if (startup.has(path)) continue
    const seen = new Set()
    const pending = [path]
    let total = 0
    while (pending.length > 0) {
      const next = pending.pop()
      if (seen.has(next) || startup.has(next) || !sizes.has(next)) continue
      seen.add(next)
      total += sizes.get(next)
      pending.push(...imports.get(next))
    }
    largest = Math.max(largest, total)
  }
  return largest
}

export async function collectArtifactMeasurements(root = repositoryRoot) {
  const web = join(root, "apps", "web", "dist")
  const desktop = join(root, "apps", "desktop", "out")
  const renderer = join(desktop, "renderer")
  const webStartup = await startupScripts(join(web, "index.html"))
  const rendererStartup = await startupScripts(join(renderer, "index.html"))
  return {
    web: {
      javascriptBytes: webStartup.total,
      lazyJavascriptBytes: await largestLazyGraph(web, webStartup.paths),
      stylesheetBytes: await sumExtensions(web, new Set([".css"])),
    },
    desktop: {
      rendererJavascriptBytes: rendererStartup.total,
      rendererLazyJavascriptBytes: await largestLazyGraph(renderer, rendererStartup.paths),
      rendererStylesheetBytes: await sumExtensions(renderer, new Set([".css"])),
      mainBytes: (await readFile(join(desktop, "main", "index.js"))).byteLength,
      preloadBytes: (await readFile(join(desktop, "preload", "index.cjs"))).byteLength,
    },
  }
}

export function evaluateArtifactBudgets(measurements, budgets) {
  const failures = []
  for (const [surface, values] of Object.entries(measurements)) {
    for (const [metric, actual] of Object.entries(values)) {
      const maximum = budgets.startup[surface][metric]
      if (actual > maximum) failures.push(`startup.${surface}.${metric}: ${actual} > ${maximum} bytes`)
    }
  }
  return failures
}

export async function checkPerformanceBudgets(root = repositoryRoot) {
  const budgets = JSON.parse(await readFile(join(root, "performance-budgets.json"), "utf8"))
  const measurements = await collectArtifactMeasurements(root)
  return { budgets, measurements, failures: evaluateArtifactBudgets(measurements, budgets) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkPerformanceBudgets()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}

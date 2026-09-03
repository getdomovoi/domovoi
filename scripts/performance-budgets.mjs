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

async function sumStartupScripts(indexHtmlPath) {
  const html = await readFile(indexHtmlPath, "utf8")
  const root = dirname(indexHtmlPath)
  let total = 0
  for (const reference of new Set(startupScriptReferences(html))) {
    const path = reference.startsWith("/")
      ? join(root, reference.slice(1))
      : resolve(root, reference)
    total += (await readFile(path)).byteLength
  }
  return total
}

export async function collectArtifactMeasurements(root = repositoryRoot) {
  const web = join(root, "apps", "web", "dist")
  const desktop = join(root, "apps", "desktop", "out")
  const renderer = join(desktop, "renderer")
  const webStartupBytes = await sumStartupScripts(join(web, "index.html"))
  const rendererStartupBytes = await sumStartupScripts(join(renderer, "index.html"))
  return {
    web: {
      javascriptBytes: webStartupBytes,
      lazyJavascriptBytes: (await sumExtensions(web, new Set([".js", ".mjs"]))) - webStartupBytes,
      stylesheetBytes: await sumExtensions(web, new Set([".css"])),
    },
    desktop: {
      rendererJavascriptBytes: rendererStartupBytes,
      rendererLazyJavascriptBytes: (await sumExtensions(renderer, new Set([".js", ".mjs"]))) - rendererStartupBytes,
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

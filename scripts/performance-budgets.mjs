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

export async function collectArtifactMeasurements(root = repositoryRoot) {
  const web = join(root, "apps", "web", "dist")
  const desktop = join(root, "apps", "desktop", "out")
  const renderer = join(desktop, "renderer")
  return {
    web: {
      javascriptBytes: await sumExtensions(web, new Set([".js", ".mjs"])),
      stylesheetBytes: await sumExtensions(web, new Set([".css"])),
    },
    desktop: {
      rendererJavascriptBytes: await sumExtensions(renderer, new Set([".js", ".mjs"])),
      rendererStylesheetBytes: await sumExtensions(renderer, new Set([".css"])),
      mainBytes: (await readFile(join(desktop, "main", "index.js"))).byteLength,
      preloadBytes: (await readFile(join(desktop, "preload", "index.mjs"))).byteLength,
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

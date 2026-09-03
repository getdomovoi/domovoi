import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { collectArtifactMeasurements, evaluateArtifactBudgets } from "./performance-budgets.mjs"

const budgets = {
  startup: {
    web: { javascriptBytes: 100, lazyJavascriptBytes: 20, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererLazyJavascriptBytes: 20,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  },
}

test("accepts production artifacts at their deterministic byte ceilings", () => {
  assert.deepEqual(evaluateArtifactBudgets({
    web: { javascriptBytes: 100, lazyJavascriptBytes: 20, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererLazyJavascriptBytes: 20,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  }, budgets), [])
})

test("reports the exact startup artifact that exceeds budget", () => {
  assert.deepEqual(evaluateArtifactBudgets({
    web: { javascriptBytes: 101, lazyJavascriptBytes: 20, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererLazyJavascriptBytes: 20,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  }, budgets), [
    "startup.web.javascriptBytes: 101 > 100 bytes",
  ])
})

test("reports a lazy chunk that exceeds its own budget", () => {
  assert.deepEqual(evaluateArtifactBudgets({
    web: { javascriptBytes: 100, lazyJavascriptBytes: 21, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererLazyJavascriptBytes: 20,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  }, budgets), [
    "startup.web.lazyJavascriptBytes: 21 > 20 bytes",
  ])
})

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "domovoi-budgets-"))
  const webDist = join(root, "apps", "web", "dist")
  const webAssets = join(webDist, "assets")
  const renderer = join(root, "apps", "desktop", "out", "renderer")
  const rendererAssets = join(renderer, "assets")
  const main = join(root, "apps", "desktop", "out", "main")
  const preload = join(root, "apps", "desktop", "out", "preload")
  await mkdir(webAssets, { recursive: true })
  await mkdir(rendererAssets, { recursive: true })
  await mkdir(main, { recursive: true })
  await mkdir(preload, { recursive: true })
  await writeFile(join(webDist, "index.html"), [
    '<link rel="stylesheet" href="/assets/styles.css">',
    '<link rel="modulepreload" crossorigin href="/assets/react.js">',
    '<link rel="modulepreload" crossorigin href="/assets/ui.js">',
    '<script type="module" crossorigin src="/assets/index.js"></script>',
    "",
  ].join("\n"))
  await writeFile(join(webAssets, "index.js"), "e".repeat(100))
  await writeFile(join(webAssets, "react.js"), "r".repeat(20))
  await writeFile(join(webAssets, "ui.js"), "u".repeat(30))
  await writeFile(join(webAssets, "terminal.js"), "t".repeat(50))
  await writeFile(join(webAssets, "styles.css"), "c".repeat(10))
  await writeFile(join(renderer, "index.html"), [
    '<link rel="modulepreload" crossorigin href="./assets/renderer-one.js">',
    '<script type="module" crossorigin src="./assets/renderer-index.js"></script>',
    "",
  ].join("\n"))
  await writeFile(join(rendererAssets, "renderer-index.js"), "e".repeat(10))
  await writeFile(join(rendererAssets, "renderer-one.js"), "o".repeat(5))
  await writeFile(join(rendererAssets, "renderer-lazy.js"), "l".repeat(25))
  await writeFile(join(rendererAssets, "renderer-styles.css"), "c".repeat(10))
  await writeFile(join(main, "index.js"), "m".repeat(30))
  await writeFile(join(preload, "index.cjs"), "p".repeat(10))
  return root
}

test("counts only the startup graph and reports lazy chunks separately", async (t) => {
  const root = await buildFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  const measurements = await collectArtifactMeasurements(root)

  assert.deepEqual(measurements, {
    web: {
      javascriptBytes: 150,
      lazyJavascriptBytes: 50,
      stylesheetBytes: 10,
    },
    desktop: {
      rendererJavascriptBytes: 15,
      rendererLazyJavascriptBytes: 25,
      rendererStylesheetBytes: 10,
      mainBytes: 30,
      preloadBytes: 10,
    },
  })
})

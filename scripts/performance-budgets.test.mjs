import assert from "node:assert/strict"
import test from "node:test"

import { evaluateArtifactBudgets } from "./performance-budgets.mjs"

const budgets = {
  startup: {
    web: { javascriptBytes: 100, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  },
}

test("accepts production artifacts at their deterministic byte ceilings", () => {
  assert.deepEqual(evaluateArtifactBudgets({
    web: { javascriptBytes: 100, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  }, budgets), [])
})

test("reports the exact startup artifact that exceeds budget", () => {
  assert.deepEqual(evaluateArtifactBudgets({
    web: { javascriptBytes: 101, stylesheetBytes: 20 },
    desktop: {
      rendererJavascriptBytes: 100,
      rendererStylesheetBytes: 20,
      mainBytes: 30,
      preloadBytes: 10,
    },
  }, budgets), [
    "startup.web.javascriptBytes: 101 > 100 bytes",
  ])
})

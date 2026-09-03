import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { readPackageScripts } from "./package-scripts.js"

const scratches: string[] = []

function scratchWith(manifest: string): string {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-scripts-"))
  scratches.push(directory)
  writeFileSync(join(directory, "package.json"), manifest)
  return directory
}

afterAll(async () => { await removeScratchDirectories(scratches) })

describe("readPackageScripts", () => {
  it("reads string scripts from the manifest beside the command", () => {
    const directory = scratchWith(JSON.stringify({ scripts: { test: "vitest run", build: "tsup" } }))
    expect(readPackageScripts(directory)).toEqual({ test: "vitest run", build: "tsup" })
  })

  it("drops entries that are not strings", () => {
    const directory = scratchWith(JSON.stringify({ scripts: { test: "vitest run", bad: { nested: true }, worse: 3 } }))
    expect(readPackageScripts(directory)).toEqual({ test: "vitest run" })
  })

  it("returns undefined when the manifest is missing, unreadable, or scriptless", () => {
    expect(readPackageScripts(mkdtempSync(join(tmpdir(), "domovoi-scripts-empty-")))).toBeUndefined()
    expect(readPackageScripts(scratchWith("{ not json"))).toBeUndefined()
    expect(readPackageScripts(scratchWith(JSON.stringify({ name: "x" })))).toBeUndefined()
    expect(readPackageScripts(scratchWith(JSON.stringify({ scripts: [] })))).toBeUndefined()
  })
})

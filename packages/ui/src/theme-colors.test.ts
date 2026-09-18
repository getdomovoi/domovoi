import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Tailwind v4 generates a colour utility only for a name registered in the
// sheet's @theme block. A class like bg-info-background with no
// --color-info-background behind it produces no CSS and no warning, so the
// element renders with no background, and text-info-foreground mapped to the
// on-solid contrast colour vanishes against the page. The approval receipt
// shipped that way: the design gave it a frame and a header, and the packaged
// app drew neither. This pins every tinted family the sheet defines.

const root = join(import.meta.dirname, "..", "src")

function registeredColorNames(): Set<string> {
  const sheet = readFileSync(join(root, "styles.css"), "utf8")
  const start = sheet.indexOf("@theme")
  const block = sheet.slice(start, sheet.indexOf("}", start))
  return new Set([...block.matchAll(/--color-([a-z0-9-]+):/g)].map((match) => match[1]!))
}

function tintedFamilies(): Set<string> {
  const sheet = readFileSync(join(root, "styles.css"), "utf8")
  return new Set([...sheet.matchAll(/^\s+--([a-z]+)-bg:/gm)].map((match) => match[1]!))
}

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) yield path
  }
}

describe("semantic colour utilities", () => {
  it("are registered in @theme for every tinted family the sheet defines", () => {
    const registered = registeredColorNames()
    const families = tintedFamilies()
    expect(families.size).toBeGreaterThan(0)
    const unregistered = new Map<string, Set<string>>()
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(/(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|divide)-([a-z]+-[a-z0-9-]+)/g)) {
        const token = match[1]!.split("/")[0]!
        if (!families.has(token.split("-")[0]!) || registered.has(token)) continue
        const files = unregistered.get(token) ?? new Set<string>()
        files.add(file.slice(root.length + 1))
        unregistered.set(token, files)
      }
    }
    expect(Object.fromEntries([...unregistered].map(([token, files]) => [token, [...files].sort()]))).toEqual({})
  })
})

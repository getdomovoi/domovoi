import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { __unstable__loadDesignSystem } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { describe, expect, it } from "vitest"

// Tailwind v4 emits CSS only for a class it can resolve, and emits nothing,
// with no warning, for one it cannot. A class that looks right in source then
// styles nothing and the element inherits whatever surrounds it. The approval
// receipt shipped that way: bg-info-background and border-info-border named
// a family the sheet never registered, so the packaged app drew no frame and
// no header. The tool ran and answered a different question than the one
// asked; this test asks the question directly. It compiles the real sheet,
// scans the same sources the sheet names with the same scanner the build
// uses, and fails on every colour-carrying utility that resolves to nothing.

const root = resolve(import.meta.dirname, "..")

// Utilities whose value is a colour or a token the sheet must register. The
// rest of Tailwind (spacing, type, layout) resolves from its own defaults and
// a typo there is visible in any render; a missing colour is not.
const colourUtility = /^(?:[a-z0-9-]+(?:\[[^\]]*\])?:)*(?:bg|text|border|ring|fill|stroke|outline|divide|shadow|from|via|to|decoration|placeholder|caret|accent)-/

// Strings the scanner extracts that are not class names. Each entry says
// where it comes from; add one only with its source.
const notClasses = new Set([
  // PreviewAnchorResolution enum value in preview-bridge.ts and artifact-dock.tsx.
  "text-quote",
])

function sources(): { base: string; pattern: string; negated: boolean }[] {
  const sheet = readFileSync(join(root, "src", "styles.css"), "utf8")
  // Tests are scanned by the build too, but a class in a test styles nothing
  // a person sees, and a CSS property name quoted in one is not a class.
  return [...sheet.matchAll(/^@source "([^"]+)";/gm)].flatMap((match) => {
    const [directory, pattern] = splitSource(match[1]!)
    const base = resolve(root, "src", directory)
    return [{ base, pattern, negated: false }, { base, pattern: "**/*.test.{ts,tsx}", negated: true }]
  })
}

function splitSource(source: string): [string, string] {
  const glob = source.indexOf("*")
  const cut = source.lastIndexOf("/", glob)
  return [source.slice(0, cut), source.slice(cut + 1)]
}

describe("colour-carrying utilities", () => {
  it("every one used in a component resolves to CSS against the real sheet", async () => {
    const sheet = readFileSync(join(root, "src", "styles.css"), "utf8")
    const design = await __unstable__loadDesignSystem(sheet, { base: join(root, "src") })
    const candidates = new Scanner({ sources: sources() }).scan()
    expect(candidates.length).toBeGreaterThan(1000)
    const wanted = candidates.filter((candidate) => colourUtility.test(candidate) && !notClasses.has(candidate))
    expect(wanted.length).toBeGreaterThan(100)
    const css = design.candidatesToCss(wanted)
    const unresolved = wanted.filter((_, index) => css[index] === null)
    expect(unresolved).toEqual([])
  })
})

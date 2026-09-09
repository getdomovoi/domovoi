import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8")

// The token block is a contract the v2 design set repeats in every file, so a
// drift here is a drift in every screen at once.
// Anchored at the start of a line, because ".dark" also appears inside the
// custom-variant declaration and would otherwise match the wrong block.
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `${selector} is missing`).toBeGreaterThan(-1)
  const open = css.indexOf("{", start)
  const end = css.indexOf("\n}", open)
  return css.slice(open, end)
}

function lightness(declarations: string, token: string): number {
  const match = new RegExp(`${token}:\\s*oklch\\(([0-9.]+)`).exec(declarations)
  expect(match, `${token} is missing or is not oklch`).not.toBeNull()
  return Number(match![1])
}

const light = block(":root,\n.light")
const dark = block(".dark")

describe("v2 colour tokens", () => {
  it("keeps ink on an amber fill dark in both themes", () => {
    // The fill is amber in both themes, so light ink on it fails in one of
    // them whichever way it is chosen. Dark ink is the only value that works
    // for both, and the pre-v2 light theme used near-white.
    expect(lightness(light, "--warning-foreground")).toBeLessThan(0.4)
    expect(lightness(dark, "--warning-foreground")).toBeLessThan(0.4)
  })

  it("carries every state ramp in both themes", () => {
    for (const theme of [light, dark]) {
      for (const ramp of ["warn", "danger", "info", "ok"]) {
        for (const step of ["bg", "border", "fg", "dim"]) {
          expect(theme).toContain(`--${ramp}-${step}:`)
        }
      }
    }
  })

  it("carries the neutral steps the designs name", () => {
    for (const theme of [light, dark]) {
      for (const token of ["--strong", "--faint", "--code", "--desk", "--skel", "--skel-hi"]) {
        expect(theme).toContain(`${token}:`)
      }
    }
  })

  it("names no token the v2 set does not define", () => {
    // --warn-fill was a pre-v2 invention with no consumer. A token nothing
    // reads is a token that drifts silently.
    expect(css).not.toContain("--warn-fill")
  })
})

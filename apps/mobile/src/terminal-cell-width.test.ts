import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { cellWidthModule, unicodeSource } from "../scripts/terminal-cell-widths.mjs"

// The table is generated from Unicode files the repository does not keep, so
// the generator runs here on a few lines in the files' own format, and the
// committed table has to be that output with only the data and its source
// different.

const fixtureSource = {
  version: "0.0.0",
  eastAsianWidth: { url: "https://example.invalid/EastAsianWidth.txt", sha256: "0".repeat(64) },
  generalCategory: { url: "https://example.invalid/DerivedGeneralCategory.txt", sha256: "1".repeat(64) },
}

const eastAsianWidth = `# EastAsianWidth-0.0.0.txt
# @missing: 0000..10FFFF; N
0041           ; Na # Lu         LATIN CAPITAL LETTER A
1100..115F     ; W  # Lo    [96] HANGUL CHOSEONG KIYEOK..HANGUL CHOSEONG FILLER
4E00..4E01     ; W  # Lo     [2] <CJK Ideograph>
FF01           ; F  # Po         FULLWIDTH EXCLAMATION MARK
`

const generalCategory = `# DerivedGeneralCategory-0.0.0.txt
00AD          ; Cf #       SOFT HYPHEN
0300..036F    ; Mn #  [112] COMBINING GRAVE ACCENT..COMBINING LATIN SMALL LETTER X
20DD          ; Me #       COMBINING ENCLOSING CIRCLE
`

// What stays the same between two runs on different data.
function shape(source: string): string {
  return source
    .replace(/^ {2}0x.*\n/gm, "")
    .replace(/Unicode [\d.]+\n/, "Unicode\n")
    .replace(/^\/\/ {3}https:\S+\n\/\/ {5}sha256 [0-9a-f]{64}\n/gm, "")
}

describe("terminal-cell-widths.mjs", () => {
  const generated = cellWidthModule(eastAsianWidth, generalCategory, fixtureSource)

  it("writes the committed table's format", () => {
    const committed = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "terminal-cell-width.ts"), "utf8")
    expect(shape(generated)).toBe(shape(committed))
    // The committed table names the files the generator pins.
    for (const file of [unicodeSource.eastAsianWidth, unicodeSource.generalCategory]) {
      expect(committed).toContain(`//   ${file.url}\n//     sha256 ${file.sha256}\n`)
    }
    expect(committed).toContain(`Unicode ${unicodeSource.version}\n`)
    expect(committed).toContain("// UNICODE LICENSE V3\n")
  })

  it("draws wide, fullwidth and default-wide code points as two cells and marks as none", () => {
    // The listed ideographs join the CJK block that is wide by default.
    expect(generated).toContain("0x1100, 0x115f, 0x3400, 0x4dbf, 0x4e00, 0x9fff,")
    expect(generated).toContain("0xff01, 0xff01, 0x20000, 0x2fffd, 0x30000, 0x3fffd,")
    expect(generated).toContain("  0x300, 0x36f, 0x1160, 0x11ff, 0x20dd, 0x20dd, 0xd7b0, 0xd7ff,\n")
    // A soft hyphen is drawn.
    expect(generated).not.toContain("0xad,")
  })

  it("refuses data that would put a mark below the table's fast path", () => {
    expect(() => cellWidthModule(eastAsianWidth, "0200 ; Mn # not a mark\n", fixtureSource)).toThrow("U+200")
  })
})

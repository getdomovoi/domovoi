// Writes apps/mobile/src/terminal-cell-width.ts, the phone terminal's table of
// how many cells a terminal gives each code point, from two files of the
// Unicode Character Database. It reads local copies and fetches nothing, so no
// build or CI run reaches the network, and it refuses a file whose SHA-256 is
// not the digest named below.
//
// Regenerate from the repository root:
//   curl -fsSLO https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
//   curl -fsSLO https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt
//   node apps/mobile/scripts/terminal-cell-widths.mjs EastAsianWidth.txt DerivedGeneralCategory.txt
// A new Unicode version means new URLs and digests in unicodeSource.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const unicodeSource = {
  version: "17.0.0",
  eastAsianWidth: {
    url: "https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt",
    sha256: "ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33",
  },
  generalCategory: {
    url: "https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt",
    sha256: "d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e",
  },
}

// The notice the Unicode License v3 asks to travel with every copy of the
// data, and so with this table drawn from it.
const unicodeLicense = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`

// Unassigned code points in these blocks default to wide, as the header of
// EastAsianWidth.txt states in prose rather than as data lines.
const wideByDefault = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fffd], [0x30000, 0x3fffd]]

// Hangul Jamo medial vowels and final consonants join the syllable before
// them, so they take no cell of their own, as wcwidth has it.
const joiningJamo = [[0x1160, 0x11ff], [0xd7b0, 0xd7ff]]

// "0300..036F ; Mn # comment" or "00AD ; Cf # comment".
function* entries(text) {
  for (const line of text.split("\n")) {
    const data = line.split("#")[0]?.trim()
    if (!data) continue
    const [range, value] = data.split(";").map((part) => part.trim())
    const [first, last = first] = range.split("..")
    yield [Number.parseInt(first, 16), Number.parseInt(last, 16), value]
  }
}

function fill(widths, first, last, width) {
  widths.fill(width, first, last + 1)
}

// Inclusive ranges of one width, as a flat list: first, last, first, last.
function rangesOf(widths, width) {
  const ranges = []
  for (let codePoint = 0; codePoint < widths.length; codePoint += 1) {
    if (widths[codePoint] !== width) continue
    if (ranges.length > 0 && ranges.at(-1) === codePoint - 1) ranges[ranges.length - 1] = codePoint
    else ranges.push(codePoint, codePoint)
  }
  return ranges
}

function hexList(ranges) {
  const lines = []
  for (let at = 0; at < ranges.length; at += 8) {
    lines.push(`  ${ranges.slice(at, at + 8).map((value) => `0x${value.toString(16)}`).join(", ")},`)
  }
  return lines.join("\n")
}

// Below this every code point is one cell, so most output skips the search.
export const firstNotNarrow = 0x300

// The table module's source for one pair of Unicode files. The rules:
// East_Asian_Width W or F is two cells; General_Category Mn, Me or Cf is no
// cell, except U+00AD SOFT HYPHEN, which terminals draw; joining Jamo is no
// cell; everything else is one. Controls are the parser's, not the table's.
export function cellWidthModule(eastAsianWidth, generalCategory, source) {
  const widths = new Uint8Array(0x110000).fill(1)
  for (const [first, last] of wideByDefault) fill(widths, first, last, 2)
  for (const [first, last, value] of entries(eastAsianWidth)) fill(widths, first, last, value === "W" || value === "F" ? 2 : 1)
  for (const [first, last, value] of entries(generalCategory)) {
    if (value === "Mn" || value === "Me" || value === "Cf") fill(widths, first, last, 0)
  }
  widths[0xad] = 1
  for (const [first, last] of joiningJamo) fill(widths, first, last, 0)
  const zeroWidth = rangesOf(widths, 0)
  const doubleWidth = rangesOf(widths, 2)
  const lowest = Math.min(zeroWidth[0] ?? Infinity, doubleWidth[0] ?? Infinity)
  if (lowest < firstNotNarrow) throw new Error(`U+${lowest.toString(16)} is not one cell, below the table's fast path`)
  return `// Generated by apps/mobile/scripts/terminal-cell-widths.mjs. Do not edit.
//
// How many cells a terminal gives one code point, from the Unicode ${source.version}
// Character Database:
//   ${source.eastAsianWidth.url}
//     sha256 ${source.eastAsianWidth.sha256}
//   ${source.generalCategory.url}
//     sha256 ${source.generalCategory.sha256}
// East_Asian_Width W or F is two cells, with the unassigned code points of
// the CJK blocks and planes 2 and 3 wide by default. General_Category Mn, Me
// or Cf is no cell, except U+00AD SOFT HYPHEN, and so are the joining Hangul
// Jamo U+1160..U+11FF and U+D7B0..U+D7FF. Everything else is one cell. This is
// a width per code point, as wcwidth gives it; a terminal that draws a whole
// grapheme cluster, such as an emoji joined with U+200D, can draw it narrower.
//
${unicodeLicense.split("\n").map((line) => line ? `// ${line}` : "//").join("\n")}

// Inclusive ranges, ascending: first, last, first, last.
const zeroWidth: readonly number[] = [
${hexList(zeroWidth)}
]

const doubleWidth: readonly number[] = [
${hexList(doubleWidth)}
]

export function cellWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint < 0x${firstNotNarrow.toString(16)}) return 1
  if (within(zeroWidth, codePoint)) return 0
  return within(doubleWidth, codePoint) ? 2 : 1
}

function within(ranges: readonly number[], codePoint: number): boolean {
  let low = 0
  let high = ranges.length / 2 - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (codePoint < (ranges[middle * 2] ?? 0)) high = middle - 1
    else if (codePoint > (ranges[middle * 2 + 1] ?? 0)) low = middle + 1
    else return true
  }
  return false
}
`
}

function verified(path, expected) {
  const text = readFileSync(path, "utf8")
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
  if (actual !== expected.sha256) throw new Error(`${path} has sha256 ${actual}, not ${expected.sha256} from ${expected.url}`)
  return text
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [eastAsianWidthPath, generalCategoryPath] = process.argv.slice(2)
  if (!eastAsianWidthPath || !generalCategoryPath) {
    console.error("usage: node apps/mobile/scripts/terminal-cell-widths.mjs EastAsianWidth.txt DerivedGeneralCategory.txt")
    process.exit(2)
  }
  const source = cellWidthModule(
    verified(eastAsianWidthPath, unicodeSource.eastAsianWidth),
    verified(generalCategoryPath, unicodeSource.generalCategory),
    unicodeSource,
  )
  writeFileSync(fileURLToPath(new URL("../src/terminal-cell-width.ts", import.meta.url)), source)
}

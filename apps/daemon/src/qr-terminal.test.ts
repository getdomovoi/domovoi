import { describe, expect, it } from "vitest"

import { qrModules, renderQrToTerminal } from "./qr-terminal.js"

describe("the terminal pairing code", () => {
  it("encodes a payload as a square symbol inside a quiet zone", () => {
    const rows = qrModules("domovoi-pair:1:example")
    expect(rows.length).toBe(rows[0]!.length)
    // The margin a scanner needs, on all four sides.
    for (const edge of [rows[0]!, rows[1]!, rows[2]!, rows[3]!, rows.at(-1)!, rows.at(-2)!, rows.at(-3)!, rows.at(-4)!]) {
      expect(edge.some(Boolean)).toBe(false)
    }
    for (const row of rows) {
      expect(row.slice(0, 4).some(Boolean)).toBe(false)
      expect(row.slice(-4).some(Boolean)).toBe(false)
    }
    // A finder pattern sits at the top left of the symbol itself.
    expect(rows[4]!.slice(4, 11)).toEqual([true, true, true, true, true, true, true])
  })

  it("grows with the text rather than truncating it", () => {
    const small = qrModules("domovoi-pair:1:aa")
    const large = qrModules(`domovoi-pair:1:${"a".repeat(600)}`)
    expect(large.length).toBeGreaterThan(small.length)
  })

  it("draws two module rows per line and nothing but block glyphs", () => {
    const rows = qrModules("domovoi-pair:1:example")
    // The trailing blank lines are the bottom of the quiet zone, so the render
    // is not trimmed: a caller that strips them takes the margin off.
    const lines = renderQrToTerminal("domovoi-pair:1:example").split("\n").slice(0, -1)
    expect(lines).toHaveLength(Math.ceil(rows.length / 2))
    expect(lines[0]!).toHaveLength(rows[0]!.length)
    expect(new Set(renderQrToTerminal("domovoi-pair:1:example").replace(/\n/g, ""))).toEqual(new Set([" ", "▀", "▄", "█"]))
  })

  it("puts a dark module in the half of the cell it belongs to", () => {
    const rows = qrModules("domovoi-pair:1:example")
    const lines = renderQrToTerminal("domovoi-pair:1:example").split("\n")
    // Row 4 is the symbol's first row and row 5 is dark only at the finder
    // corners, so the first cell of that line carries both halves.
    const line = lines[2]!
    for (let x = 0; x < rows[4]!.length; x += 1) {
      const top = rows[4]![x]!, bottom = rows[5]![x]!
      expect(line[x], `column ${x}`).toBe(top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ")
    }
  })
})

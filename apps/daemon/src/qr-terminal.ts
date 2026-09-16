import qrcode from "qrcode-generator"

// A pairing code has to be scannable from the machine that shows it, and a
// machine with no desktop has only its terminal. Two module rows share one
// character cell through the half-block glyph, so the code stays square in a
// font that is twice as tall as it is wide, and small enough to fit an
// ordinary window.
const upper = "▀"
const lower = "▄"
const both = "█"
const neither = " "

// A quiet zone is part of the symbol, not decoration: a scanner needs the
// margin to find the finder patterns against whatever is printed above.
const quietZoneModules = 4

export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, "M")
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  const width = size + quietZoneModules * 2
  const rows: boolean[][] = []
  for (let y = 0; y < width; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < width; x += 1) {
      const inside = y >= quietZoneModules && y < quietZoneModules + size
        && x >= quietZoneModules && x < quietZoneModules + size
      row.push(inside && code.isDark(y - quietZoneModules, x - quietZoneModules))
    }
    rows.push(row)
  }
  return rows
}

// Dark modules are drawn as foreground glyphs on the terminal's own
// background, so the symbol reads on a light or a dark profile without the
// daemon guessing which one is in use.
export function renderQrToTerminal(text: string): string {
  const rows = qrModules(text)
  const lines: string[] = []
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y]!
    const bottom = rows[y + 1]
    let line = ""
    for (let x = 0; x < top.length; x += 1) {
      const isTop = top[x]!
      const isBottom = bottom?.[x] ?? false
      line += isTop && isBottom ? both : isTop ? upper : isBottom ? lower : neither
    }
    lines.push(line)
  }
  return `${lines.join("\n")}\n`
}

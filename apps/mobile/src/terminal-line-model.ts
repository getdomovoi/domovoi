import { cellWidth } from "./terminal-cell-width"

// What a terminal draws, as lines of cells. The phone draws lines and lets a
// long one wrap at its own width, so this models one line at a time: the
// cursor moves along the current line, and a line break starts the next. A
// move to another row, as a full-screen program makes, is read and dropped,
// and what follows is drawn on the current line. A line wider than the
// holder's grid is not wrapped into rows here either, so a carriage return
// returns to the start of the whole line, not of its last row.
//
// The escape sequences are read as the DEC VT parser reads them
// (https://vt100.net/emu/dec_ansi_parser): a control sequence runs to its
// final byte; a window title (OSC) to a bell or the string terminator, ESC
// then backslash; a device control string (DCS), a start of string (SOS), a
// privacy message (PM) and an application program command (APC) to the
// string terminator. Their payloads draw nothing, and a sequence still
// arriving at the end of the text draws nothing either.

// A cell never written, or erased.
const blank = ""
// The right half of a wide character, drawn by the character on its left.
const rightHalf = "\u0000"

// The widest grid the protocol allows a terminal. A cursor move or a count
// past it is cut to it, as a terminal cuts one at its right margin. Inserting
// and deleting characters act on the cursor's row of this many cells, so a
// line longer than any grid costs no more per sequence than a full row.
const widestGrid = 1_000

// Tab stops every eight columns, as a terminal sets them by default.
const tabWidth = 8

class Line {
  cells: string[] = []
  column = 0

  print(char: string): void {
    const width = cellWidth(char.codePointAt(0) ?? 0)
    if (width === 0) {
      // A mark sits on the character before the cursor. With none there, at
      // the start of a line or after a blank, it has nothing to sit on.
      let at = this.column - 1
      if (this.cells[at] === rightHalf) at -= 1
      if (at >= 0 && (this.cells[at] ?? blank) !== blank) this.cells[at] += char
      return
    }
    this.clear(this.column)
    if (width === 2) this.clear(this.column + 1)
    while (this.cells.length < this.column) this.cells.push(blank)
    this.cells[this.column] = char
    if (width === 2) this.cells[this.column + 1] = rightHalf
    this.column += width
  }

  // Blank one cell. Either half of a wide character takes the whole of it.
  clear(at: number): void {
    if (at >= this.cells.length) return
    if (this.cells[at] === rightHalf) this.cells[at - 1] = blank
    else if (this.cells[at + 1] === rightHalf) this.cells[at + 1] = blank
    this.cells[at] = blank
  }

  // Text can run past the widest grid, as the phone does not wrap it into
  // rows, so a move back from there is not pulled to the margin.
  moveTo(column: number): void {
    this.column = Math.max(0, Math.min(column, Math.max(this.column, widestGrid - 1)))
  }

  tab(): void {
    this.moveTo((Math.floor(this.column / tabWidth) + 1) * tabWidth)
  }

  // Where the cursor's row of the widest grid starts and ends.
  rowStart(): number {
    return Math.floor(this.column / widestGrid) * widestGrid
  }

  // Erase in line: 0 from the cursor to the end, 1 from the start of the
  // cursor's row through the cursor, 2 all of it.
  erase(mode: number): void {
    if (mode === 0) {
      this.clear(this.column)
      this.cells.length = Math.min(this.cells.length, this.column)
    } else if (mode === 1) {
      const through = Math.min(this.column, this.cells.length - 1)
      for (let at = this.rowStart(); at <= through; at += 1) this.clear(at)
    } else if (mode === 2) {
      this.cells = []
    }
  }

  // Erase characters: blank count cells from the cursor, which stays.
  eraseCharacters(count: number): void {
    const end = Math.min(this.column + count, this.cells.length)
    for (let at = this.column; at < end; at += 1) this.clear(at)
  }

  // Delete characters: the cells right of them in the cursor's row move
  // left, and blanks enter at the row's end. A wide character with one half
  // deleted loses the other half too.
  deleteCharacters(count: number): void {
    const rowEnd = Math.min(this.cells.length, this.rowStart() + widestGrid)
    const deleted = Math.min(count, rowEnd - this.column)
    if (deleted <= 0) return
    if (this.cells[this.column] === rightHalf) this.cells[this.column - 1] = blank
    if (this.cells[this.column + deleted] === rightHalf) this.cells[this.column + deleted] = blank
    // A wide character across the row's end cannot move as one.
    if (this.cells[rowEnd] === rightHalf) this.clear(rowEnd)
    for (let at = this.column; at < rowEnd - deleted; at += 1) this.cells[at] = this.cells[at + deleted] ?? blank
    for (let at = rowEnd - deleted; at < rowEnd; at += 1) this.cells[at] = blank
  }

  // Insert characters: blanks at the cursor push the rest of the cursor's
  // row right, and what passes the row's end is lost. Blanks put between
  // the halves of a wide character clear it.
  insertCharacters(count: number): void {
    if (this.column >= this.cells.length) return
    const rowEnd = this.rowStart() + widestGrid
    const inserted = Math.min(count, rowEnd - this.column)
    if (this.cells[this.column] === rightHalf) this.clear(this.column)
    // A wide character pushed half past the row's end is lost whole, and so
    // is one the row's end already cut.
    if (this.cells[rowEnd - inserted] === rightHalf) this.clear(rowEnd - inserted)
    if (this.cells[rowEnd] === rightHalf) this.clear(rowEnd)
    const end = Math.min(rowEnd, this.cells.length + inserted)
    for (let at = end - 1; at >= this.column + inserted; at -= 1) this.cells[at] = this.cells[at - inserted] ?? blank
    for (let at = this.column; at < this.column + inserted; at += 1) this.cells[at] = blank
  }

  // Blanks are spaces between text and nothing after it.
  drawn(): string {
    let end = this.cells.length
    while (end > 0 && this.cells[end - 1] === blank) end -= 1
    let text = ""
    for (let at = 0; at < end; at += 1) {
      const cell = this.cells[at] ?? blank
      text += cell === blank ? " " : cell === rightHalf ? "" : cell
    }
    return text
  }
}

type State = "ground" | "escape" | "escapeIntermediate" | "csi" | "osc" | "controlString"

// What one character does: nothing drawn, drawn as text, a control such as a
// line break carried out, or a control sequence ended.
type Action = "none" | "print" | "execute" | "dispatch"

// The DEC VT parser's states and transitions, without the drawing.
class Reader {
  state: State = "ground"
  // Where the sequence being read began, in UTF-16 units of the text.
  start = 0
  parameters = ""
  intermediates = ""
  malformed = false

  step(char: string, code: number, index: number): Action {
    // Anywhere: CAN and SUB abandon a sequence; ESC and the 8-bit controls,
    // read as ESC and the character 0x40 above them, begin one.
    if (code === 0x18 || code === 0x1a) {
      this.state = "ground"
      return "none"
    }
    if (code === 0x1b) {
      this.start = index
      this.state = "escape"
      return "none"
    }
    if (code >= 0x80 && code <= 0x9f) {
      this.start = index
      this.state = this.introduced(code - 0x40)
      return "none"
    }
    // A string's payload draws nothing. A bell ends a window title only.
    if (this.state === "osc" || this.state === "controlString") {
      if (this.state === "osc" && code === 0x07) this.state = "ground"
      return "none"
    }
    // Other controls act wherever they arrive, a sequence included.
    if (code < 0x20) return "execute"
    if (code === 0x7f) return "none"
    switch (this.state) {
      case "escape":
        if (code <= 0x2f) {
          this.state = "escapeIntermediate"
          return "none"
        }
        if (code <= 0x7e) {
          this.state = this.introduced(code)
          return "none"
        }
        // Not an escape at all: the character is text.
        this.state = "ground"
        return "print"
      case "escapeIntermediate":
        if (code <= 0x2f) return "none"
        this.state = "ground"
        return code <= 0x7e ? "none" : "print"
      case "csi":
        if (code <= 0x2f) {
          this.intermediates += char
          return "none"
        }
        if (code <= 0x3f) {
          // A parameter after an intermediate, or a private marker after a
          // parameter, leaves the sequence malformed: read to its end and
          // dropped.
          if (this.intermediates !== "" || (this.parameters !== "" && code >= 0x3c)) this.malformed = true
          this.parameters += char
          return "none"
        }
        this.state = "ground"
        if (code <= 0x7e) return this.malformed || this.intermediates !== "" ? "none" : "dispatch"
        return "print"
      case "ground":
        return "print"
    }
  }

  // The state an escape's second character opens.
  introduced(code: number): State {
    if (code === 0x5b) {
      this.parameters = ""
      this.intermediates = ""
      this.malformed = false
      return "csi"
    }
    if (code === 0x5d) return "osc"
    if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) return "controlString"
    return "ground"
  }
}

// Every line the text draws, the last one included even when it is empty:
// a text ending in a line break draws an empty line after it.
export function drawnLines(text: string): string[] {
  const lines: string[] = []
  let line = new Line()
  const reader = new Reader()
  let index = 0
  for (const char of text) {
    const action = reader.step(char, char.codePointAt(0) ?? 0, index)
    index += char.length
    if (action === "print") line.print(char)
    else if (action === "execute") {
      if (char === "\n") {
        lines.push(line.drawn())
        line = new Line()
      } else if (char === "\r") line.moveTo(0)
      else if (char === "\b") line.moveTo(line.column - 1)
      else if (char === "\t") line.tab()
    } else if (action === "dispatch") {
      dispatch(line, char, reader.parameters)
    }
  }
  lines.push(line.drawn())
  return lines
}

function dispatch(line: Line, final: string, parameters: string): void {
  // Private sequences, such as mode changes, move nothing on a line.
  if (/^[<=>?]/.test(parameters)) return
  const first = Number.parseInt(parameters.split(";")[0] ?? "", 10)
  const given = Number.isNaN(first) ? 0 : first
  const count = Math.min(Math.max(1, given), widestGrid)
  switch (final) {
    case "K": line.erase(given); break
    case "C": case "a": line.moveTo(line.column + count); break
    case "D": line.moveTo(line.column - count); break
    case "G": case "`": line.moveTo(count - 1); break
    case "X": line.eraseCharacters(count); break
    case "P": line.deleteCharacters(count); break
    case "@": line.insertCharacters(count); break
    // Colour, and moves to another row, change nothing the phone draws.
    default: break
  }
}

// Where to cut the front of a text so that what is kept reads as the
// terminal read it. The cut goes after the first line break the terminal
// drew within lineBreakReach past the wanted cut; else at the first place
// past it that is plain text, after any sequence it lands in. A sequence
// still arriving there is kept whole from its start when that start is
// within unfinishedReach; past that, the cut stays near the wanted one and
// prefix opens the same kind of sequence again, so the rest of its payload
// still draws nothing. What is kept is prefix then text from at, never
// longer than text from cut.
export function readableCut(
  text: string,
  cut: number,
  lineBreakReach: number,
  unfinishedReach: number,
): { at: number, prefix: string } {
  const reader = new Reader()
  let plainAt = cut <= 0 ? 0 : undefined
  let index = 0
  for (const char of text) {
    const action = reader.step(char, char.codePointAt(0) ?? 0, index)
    const lineBreak = index
    index += char.length
    if (char === "\n" && action === "execute" && reader.state === "ground" && lineBreak >= cut - 1 && index - cut <= lineBreakReach) {
      return { at: index, prefix: "" }
    }
    if (plainAt === undefined && index >= cut && reader.state === "ground") plainAt = index
    if (plainAt !== undefined && index - cut > lineBreakReach) break
  }
  if (plainAt !== undefined) return { at: plainAt, prefix: "" }
  if (cut - reader.start <= unfinishedReach) return { at: reader.start, prefix: "" }
  const prefix = reader.state === "osc" ? "\u001b]" : reader.state === "controlString" ? "\u001bP" : reader.state === "csi" ? "\u001b[!" : "\u001b "
  let at = cut + prefix.length
  // The two halves of a character outside the basic plane stay together.
  const code = text.charCodeAt(at)
  if (code >= 0xdc00 && code <= 0xdfff) at += 1
  return { at, prefix }
}

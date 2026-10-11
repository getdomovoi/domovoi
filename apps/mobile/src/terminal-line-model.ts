import { cellWidth } from "./terminal-cell-width"

// What a terminal draws, as lines of cells. The phone draws lines and lets a
// long one wrap at its own width, so this models one line at a time: the
// cursor moves along the current line, and a line break starts the next. A
// move to another row, as a full-screen program makes, is read and dropped,
// and what follows is drawn on the current line. A line wider than the
// holder's grid is not wrapped into rows here either, so a carriage return
// returns to the start of the whole line, not of its last row.
//
// The escape sequences are read as the DEC VT parser reads them: a control
// sequence runs to its final byte; a window title (OSC) to a bell or the
// string terminator, ESC then backslash; a device control string (DCS), a
// start of string (SOS), a privacy message (PM) and an application program
// command (APC) to the string terminator. Their payloads draw nothing, and
// a sequence still arriving at the end of the text draws nothing either.

// A cell never written, or erased.
const blank = ""
// The right half of a wide character, drawn by the character on its left.
const rightHalf = "\u0000"

// The widest grid the protocol allows a terminal. A cursor move or a count
// past it is cut to it, as a terminal cuts one at its right margin.
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

  // Erase in line: 0 from the cursor to the end, 1 from the start through
  // the cursor, 2 all of it.
  erase(mode: number): void {
    if (mode === 0) {
      this.clear(this.column)
      this.cells.length = Math.min(this.cells.length, this.column)
    } else if (mode === 1) {
      for (let at = 0; at <= this.column; at += 1) this.clear(at)
    } else if (mode === 2) {
      this.cells = []
    }
  }

  // Erase characters: blank count cells from the cursor, which stays.
  eraseCharacters(count: number): void {
    for (let at = this.column; at < this.column + count; at += 1) this.clear(at)
  }

  // Delete characters: the cells right of them move left. A wide character
  // with one half deleted loses the other half too.
  deleteCharacters(count: number): void {
    if (this.cells[this.column] === rightHalf) this.cells[this.column - 1] = blank
    if (this.cells[this.column + count] === rightHalf) this.cells[this.column + count] = blank
    this.cells.splice(this.column, count)
  }

  // Insert characters: blanks at the cursor push the rest right. Blanks put
  // between the halves of a wide character clear it.
  insertCharacters(count: number): void {
    if (this.column >= this.cells.length) return
    if (this.cells[this.column] === rightHalf) this.clear(this.column)
    this.cells.splice(this.column, 0, ...Array<string>(count).fill(blank))
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

const ESC = "\u001b"
const BEL = "\u0007"
const CAN = "\u0018"
const SUB = "\u001a"
// The 8-bit string terminator, which ends a string as ESC then backslash does.
const ST = "\u009c"

// Every line the text draws, the last one included even when it is empty:
// a text ending in a line break draws an empty line after it.
export function drawnLines(text: string): string[] {
  const lines: string[] = []
  let line = new Line()
  let state: State = "ground"
  let parameters = ""
  let intermediates = ""

  const execute = (char: string): void => {
    if (char === "\n") {
      lines.push(line.drawn())
      line = new Line()
    } else if (char === "\r") line.moveTo(0)
    else if (char === "\b") line.moveTo(line.column - 1)
    else if (char === "\t") line.tab()
  }

  const dispatch = (final: string): void => {
    // Private sequences, such as mode changes, and ones with intermediates
    // move nothing on a line.
    if (intermediates !== "" || /^[<=>?]/.test(parameters)) return
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

  // An escape's second character. An 8-bit control is read as ESC and the
  // character 0x40 below it.
  const escape = (char: string): State => {
    if (char === "[") {
      parameters = ""
      intermediates = ""
      return "csi"
    }
    if (char === "]") return "osc"
    if (char === "P" || char === "X" || char === "^" || char === "_") return "controlString"
    return "ground"
  }

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === CAN || char === SUB) {
      state = "ground"
      continue
    }
    if (state === "osc" || state === "controlString") {
      if (char === ESC) state = "escape"
      else if (char === ST || (state === "osc" && char === BEL)) state = "ground"
      continue
    }
    if (char === ESC) {
      state = "escape"
      continue
    }
    if (code >= 0x80 && code <= 0x9f) {
      state = escape(String.fromCharCode(code - 0x40))
      continue
    }
    if (code < 0x20) {
      execute(char)
      continue
    }
    // DEL draws nothing and leaves a sequence where it was.
    if (code === 0x7f) continue
    if (state === "escape") {
      if (code >= 0x20 && code <= 0x2f) state = "escapeIntermediate"
      else if (code <= 0x7e) state = escape(char)
      else {
        // Not an escape at all: the character is text.
        state = "ground"
        line.print(char)
      }
      continue
    }
    if (state === "escapeIntermediate") {
      if (code >= 0x30 && code <= 0x7e) state = "ground"
      else if (code > 0x7e) {
        state = "ground"
        line.print(char)
      }
      continue
    }
    if (state === "csi") {
      // A parameter after an intermediate leaves the sequence malformed; it
      // is read to its end and, having intermediates, dropped.
      if (code >= 0x30 && code <= 0x3f) parameters += char
      else if (code >= 0x20 && code <= 0x2f) intermediates += char
      else if (code <= 0x7e) {
        dispatch(char)
        state = "ground"
      } else {
        state = "ground"
        line.print(char)
      }
      continue
    }
    line.print(char)
  }
  lines.push(line.drawn())
  return lines
}

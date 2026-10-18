import { cellWidth } from "./terminal-cell-width"

// What a terminal draws, as lines of cells. The phone draws lines and lets a
// long one wrap at its own width, so this models one line at a time: the
// cursor moves along the current line, and a line break starts the next.
//
// Given the holder's grid width, a line wider than the grid is read as the
// rows the holder's terminal wraps it into, without breaking it for the
// phone. A carriage return goes to the start of the cursor's row, a move
// along the row stops at its edges, an erase in line erases that row, and a
// move up or down goes between the line's rows, as a shell does when what is
// typed, or a suggestion after it, runs past the grid (zsh moves down a row
// and returns, rather than printing a line break, before a command's output,
// F17). A move down past the line's last row starts the next line, once
// however far it goes: the phone keeps no screen, so how far below is not
// known. A move up past the line's first row is dropped, and what follows is
// drawn on the current line; a later move down first undoes that. Without
// the grid, or for any other move to another row, as a full-screen program
// makes, the move is read and dropped, and a carriage return returns to the
// start of the whole line. The grid is the holder's current one, so a line
// drawn before the holder resized is read at the new width.
//
// The escape sequences are read as the DEC VT parser reads them
// (https://vt100.net/emu/dec_ansi_parser): a control sequence runs to its
// final byte; a window title (OSC) to a bell or the string terminator, ESC
// then backslash; a device control string (DCS), a start of string (SOS), a
// privacy message (PM) and an application program command (APC) to the
// string terminator. Their payloads draw nothing, and a sequence still
// arriving at the end of the text draws nothing either.

// A cell erased. A cell never written is a hole in its row, read the same.
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

type Cell = string | undefined

// Blank cells that cursor moves and inserts may add past what was written,
// across all the lines of one text: one record's worth. Without a bound, a
// move of a thousand columns and one character, repeated, would draw a
// thousand blanks for every few characters received. Once they are spent, a
// move past what was written stops at its end and an insert pushes nothing
// past it.
const spareBlankCells = 65_536

type SpareBlanks = { cells: number }

function isBlankCell(cell: Cell): boolean {
  return cell === undefined || cell === blank
}

// A line of cells, kept in rows of the widest grid. Every row but the last is
// full, so a column's row and place follow from it, and an insert or a delete
// moves cells within one row with the array's own splice, which the phone's
// JavaScript engine runs far faster than a loop over cells. So each sequence
// costs at most a row of cells, and an erase to the cursor touches only cells
// not already known blank.
class Line {
  rows: Cell[][] = [[]]
  column = 0
  // Every cell below this one is blank.
  blankBelow = 0
  // The farthest the cursor has been on this line.
  farthest = 0
  // A character just filled the last cell of a row of the holder's grid. The
  // terminal keeps the cursor on that cell until the next character wraps, so
  // anything but a character acts there (settle).
  wrapPending = false

  // columns: the holder's grid width, or undefined to read the line as one row.
  constructor(readonly spare: SpareBlanks, readonly columns: number | undefined) {}

  get length(): number {
    const last = this.rows.length - 1
    return last * widestGrid + (this.rows[last]?.length ?? 0)
  }

  get(at: number): Cell {
    if (at < 0) return undefined
    return this.rows[Math.floor(at / widestGrid)]?.[at % widestGrid]
  }

  set(at: number, cell: string): void {
    const index = Math.floor(at / widestGrid)
    while (this.rows.length <= index) {
      // A row is full before the next one starts; what was never written in
      // it is a hole.
      const last = this.rows[this.rows.length - 1]
      if (last) last.length = widestGrid
      this.rows.push([])
    }
    const row = this.rows[index]
    if (row) row[at % widestGrid] = cell
  }

  isBlank(at: number): boolean {
    return isBlankCell(this.get(at))
  }

  print(char: string): void {
    const width = cellWidth(char.codePointAt(0) ?? 0)
    if (width === 0) {
      // A mark sits on the character before the cursor. With none there, at
      // the start of a line or after a blank, it has nothing to sit on.
      let at = this.column - 1
      if (this.get(at) === rightHalf) at -= 1
      const cell = this.get(at)
      if (at >= 0 && cell !== undefined && cell !== blank) this.set(at, cell + char)
      return
    }
    this.clear(this.column)
    if (width === 2) this.clear(this.column + 1)
    this.set(this.column, char)
    if (width === 2) this.set(this.column + 1, rightHalf)
    this.blankBelow = Math.min(this.blankBelow, this.column)
    this.column += width
    this.farthest = Math.max(this.farthest, this.column)
    this.wrapPending = this.columns !== undefined && this.column % this.columns === 0
  }

  // Puts the cursor where the terminal has it after a character filled a
  // row: on that row's last cell.
  settle(): void {
    if (!this.wrapPending) return
    this.wrapPending = false
    this.column -= 1
  }

  // Where the cursor's row of the holder's grid starts and ends. Without the
  // grid the line is one row, as far as a move can reach.
  gridRowStart(): number {
    return this.columns === undefined ? 0 : this.column - (this.column % this.columns)
  }

  gridRowEnd(): number {
    return this.columns === undefined ? Infinity : this.gridRowStart() + this.columns
  }

  carriageReturn(): void {
    this.settle()
    this.moveTo(this.gridRowStart())
  }

  backspace(): void {
    this.settle()
    this.moveTo(Math.max(this.column - 1, this.gridRowStart()))
  }

  // Moves along the cursor's row, stopping at its edges.
  forward(count: number): void {
    this.settle()
    this.moveTo(Math.min(this.column + count, this.gridRowEnd() - 1))
  }

  back(count: number): void {
    this.settle()
    this.moveTo(Math.max(this.column - count, this.gridRowStart()))
  }

  toColumn(column: number): void {
    this.settle()
    this.moveTo(this.gridRowStart() + (this.columns === undefined ? column : Math.min(column, this.columns)) - 1)
  }

  // Up a number of rows within this line, and to the row's start for CPL.
  // What is left over goes up past the line's first row.
  up(count: number, toStart: boolean): number {
    this.settle()
    if (this.columns === undefined) return count
    const moved = Math.min(count, Math.floor(this.column / this.columns))
    this.moveTo(this.column - moved * this.columns)
    if (toStart) this.moveTo(this.gridRowStart())
    return count - moved
  }

  // Down a number of rows within this line's text, and to the row's start for
  // CNL. What is left over goes past the line's last row.
  down(count: number, toStart: boolean): number {
    this.settle()
    if (this.columns === undefined) return 0
    this.trim()
    const lastRow = this.length > 0 ? Math.floor((this.length - 1) / this.columns) : 0
    const moved = Math.min(count, Math.max(0, lastRow - Math.floor(this.column / this.columns)))
    this.moveTo(this.column + moved * this.columns)
    if (toStart) this.moveTo(this.gridRowStart())
    return count - moved
  }

  // Blank one cell. Either half of a wide character takes the whole of it.
  clear(at: number): void {
    if (at >= this.length) return
    if (this.get(at) === rightHalf) this.set(at - 1, blank)
    else if (this.get(at + 1) === rightHalf) this.set(at + 1, blank)
    this.set(at, blank)
  }

  // Nothing from this column on. A wide character the cut splits goes whole.
  truncate(at: number): void {
    if (at >= this.length) return
    if (this.get(at) === rightHalf) this.set(at - 1, blank)
    const index = Math.floor(at / widestGrid)
    this.rows.length = index + 1
    const row = this.rows[index]
    if (row) row.length = at % widestGrid
  }

  // Blanks at the end are nothing, so what the next sequence moves is short.
  trim(): void {
    for (;;) {
      const last = this.rows[this.rows.length - 1]
      if (!last) return
      while (last.length > 0 && isBlankCell(last[last.length - 1])) last.length -= 1
      if (last.length > 0 || this.rows.length === 1) return
      this.rows.pop()
    }
  }

  // Text can run past the widest grid, as the phone does not wrap it into
  // rows, so a move back from there is not pulled to the margin. At the
  // holder's grid every move is already bounded by the row it lands on, which
  // can lie past the widest grid in a long line. A move past what was written
  // and anywhere the cursor has been spends spare blanks.
  moveTo(column: number): void {
    const margin = this.columns === undefined ? Math.max(this.column, widestGrid - 1) : column
    let target = Math.max(0, Math.min(column, margin))
    const reach = Math.max(this.length, this.farthest)
    if (target > reach) {
      const granted = Math.min(target - reach, this.spare.cells)
      this.spare.cells -= granted
      target = reach + granted
    }
    this.column = target
    this.farthest = Math.max(this.farthest, target)
    this.wrapPending = false
  }

  // The next tab stop on the cursor's row, or the row's last cell.
  tab(): void {
    this.settle()
    const start = this.gridRowStart()
    this.moveTo(Math.min(start + (Math.floor((this.column - start) / tabWidth) + 1) * tabWidth, this.gridRowEnd() - 1))
  }

  // Where the cursor's row of the widest grid ends.
  rowEnd(): number {
    return (Math.floor(this.column / widestGrid) + 1) * widestGrid
  }

  // Erase in line: 0 from the cursor to the end, 1 from the start through
  // the cursor, 2 all of it. At the holder's grid the line is the cursor's
  // row: rows after it keep their text, and a row before it is blanked
  // rather than cut, so the rows after it stay where they are.
  erase(mode: number): void {
    this.settle()
    const start = this.gridRowStart()
    const end = this.gridRowEnd()
    if (this.length > end && mode !== 1) {
      this.blank(mode === 0 ? this.column : start, end)
      return
    }
    if (start > 0) {
      const through = Math.min(this.column, this.length - 1)
      if (mode === 1 && through >= start) {
        this.blank(start, through + 1)
        this.trim()
      } else if (mode !== 1) {
        const from = mode === 0 ? this.column : start
        this.clear(from)
        this.truncate(from)
      }
      return
    }
    if (mode === 0) {
      this.clear(this.column)
      this.truncate(this.column)
    } else if (mode === 1) {
      const through = Math.min(this.column, this.length - 1)
      if (through >= this.blankBelow) this.blank(this.blankBelow, through + 1)
      this.blankBelow = Math.max(this.blankBelow, through + 1)
      this.trim()
    } else if (mode === 2) {
      this.rows = [[]]
      this.blankBelow = 0
    }
  }

  // Blank the cells from start up to end, within the line. A wide character
  // with a half in the range goes whole. Each row's own fill does its run.
  blank(start: number, end: number): void {
    this.clear(start)
    this.clear(end - 1)
    for (let index = Math.floor(start / widestGrid); index * widestGrid < end; index += 1) {
      const rowStart = index * widestGrid
      this.rows[index]?.fill(blank, Math.max(start - rowStart, 0), Math.min(end - rowStart, widestGrid))
    }
  }

  // Erase characters: blank count cells from the cursor, which stays. Cells
  // known blank are not blanked again.
  eraseCharacters(count: number): void {
    this.settle()
    const end = Math.min(this.column + count, this.length, this.gridRowEnd())
    const start = this.column <= this.blankBelow ? this.blankBelow : this.column
    if (end <= start) return
    this.blank(start, end)
    if (this.column <= this.blankBelow) this.blankBelow = end
    this.trim()
  }

  // The cursor's row, and whether it is the line's last.
  cursorRow(): { row: Cell[] | undefined, last: boolean } {
    const index = Math.floor(this.column / widestGrid)
    return { row: this.rows[index], last: index === this.rows.length - 1 }
  }

  // Delete characters: the cells right of them in the cursor's row move
  // left, and blanks enter at the row's end. A wide character with one half
  // deleted loses the other half too.
  deleteCharacters(count: number): void {
    // At the holder's grid the cursor acts where the terminal has it, but the
    // cells that move are still those of the widest grid's row, not of the
    // holder's row.
    this.settle()
    const rowEnd = this.rowEnd()
    const deleted = Math.min(count, Math.min(this.length, rowEnd) - this.column)
    if (deleted <= 0) return
    if (this.get(this.column) === rightHalf) this.set(this.column - 1, blank)
    if (this.get(this.column + deleted) === rightHalf) this.set(this.column + deleted, blank)
    // A wide character across the row's end cannot move as one.
    if (this.get(rowEnd) === rightHalf) this.clear(rowEnd)
    const { row, last } = this.cursorRow()
    row?.splice(this.column % widestGrid, deleted)
    // A row before the last stays full: holes, which are blanks, enter at its end.
    if (row && !last) row.length = widestGrid
    this.blankBelow = Math.min(this.blankBelow, this.column)
    this.trim()
  }

  // Insert characters: blanks at the cursor push the rest of the cursor's
  // row right, and what passes the row's end is lost. Blanks put between
  // the halves of a wide character clear it.
  insertCharacters(count: number): void {
    // As for deleting: the widest grid's row moves, not the holder's.
    this.settle()
    if (this.column >= this.length) return
    const rowEnd = this.rowEnd()
    const inserted = Math.min(count, rowEnd - this.column)
    if (this.get(this.column) === rightHalf) this.clear(this.column)
    // A wide character pushed half past the row's end is lost whole, and so
    // is one the row's end already cut.
    if (this.get(rowEnd - inserted) === rightHalf) this.clear(rowEnd - inserted)
    if (this.get(rowEnd) === rightHalf) this.clear(rowEnd)
    const { row } = this.cursorRow()
    if (!row) return
    const before = this.length
    if (inserted === 1) row.splice(this.column % widestGrid, 0, blank)
    else row.splice(this.column % widestGrid, 0, ...Array<string>(inserted).fill(blank))
    if (row.length > widestGrid) row.length = widestGrid
    // A line made longer spends spare blanks; past them, what was pushed
    // beyond the line's old end is lost.
    const grown = this.length - before
    const granted = Math.min(grown, this.spare.cells)
    this.spare.cells -= granted
    if (granted < grown) this.truncate(before + granted)
    this.trim()
  }

  // Blanks are spaces between text and nothing after it.
  drawn(): string {
    this.trim()
    let text = ""
    for (const row of this.rows) {
      for (let at = 0; at < row.length; at += 1) {
        const cell = row[at]
        text += cell === undefined || cell === blank ? " " : cell === rightHalf ? "" : cell
      }
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

// What a text draws: every line, the last one included even when it is
// empty, as a text ending in a line break draws an empty line after it; and
// where each line after the first starts in the text, just past the line
// break the terminal drew. A line break inside a payload is not one.
export type DrawnText = { lines: string[], lineStarts: number[] }

// columns: the holder's grid width, when known (see the top of this file).
export function drawnText(text: string, columns?: number): DrawnText {
  const lines: string[] = []
  const lineStarts: number[] = []
  const spare: SpareBlanks = { cells: spareBlankCells }
  const grid = columns !== undefined && Number.isInteger(columns) && columns > 0 ? Math.min(columns, widestGrid) : undefined
  let line = new Line(spare, grid)
  // Rows the cursor went up past the current line's first row, which the
  // phone does not follow. A move down comes back through them first.
  let above = 0
  const reader = new Reader()
  let index = 0
  for (const char of text) {
    const action = reader.step(char, char.codePointAt(0) ?? 0, index)
    index += char.length
    if (action === "print") line.print(char)
    else if (action === "execute") {
      if (char === "\n") {
        lines.push(line.drawn())
        lineStarts.push(index)
        line = new Line(spare, grid)
        above = 0
      } else if (char === "\r") line.carriageReturn()
      else if (char === "\b") line.backspace()
      else if (char === "\t") line.tab()
    } else if (action === "dispatch") {
      const vertical = verticalMove(char, reader.parameters)
      if (vertical === undefined) dispatch(line, char, reader.parameters)
      else if (grid === undefined || vertical.rows === 0) continue
      else if (vertical.rows < 0) {
        above += line.up(-vertical.rows, vertical.toStart)
      } else {
        const back = Math.min(vertical.rows, above)
        above -= back
        const past = line.down(vertical.rows - back, vertical.toStart)
        if (past > 0) {
          const column = vertical.toStart ? 0 : line.column - line.gridRowStart()
          lines.push(line.drawn())
          lineStarts.push(index)
          line = new Line(spare, grid)
          line.moveTo(column)
        } else if (vertical.toStart) {
          line.carriageReturn()
        }
      }
    }
  }
  lines.push(line.drawn())
  return { lines, lineStarts }
}

// A move up (negative) or down a number of rows: CUU, CUD, and CPL and CNL,
// which also go to the row's start. A private sequence moves nothing.
function verticalMove(final: string, parameters: string): { rows: number, toStart: boolean } | undefined {
  if (final !== "A" && final !== "B" && final !== "E" && final !== "F") return undefined
  if (/^[<=>?]/.test(parameters)) return { rows: 0, toStart: false }
  const first = Number.parseInt(parameters.split(";")[0] ?? "", 10)
  const count = Math.min(Math.max(1, Number.isNaN(first) ? 0 : first), widestGrid)
  return { rows: final === "A" || final === "F" ? -count : count, toStart: final === "E" || final === "F" }
}

function dispatch(line: Line, final: string, parameters: string): void {
  // Private sequences, such as mode changes, move nothing on a line.
  if (/^[<=>?]/.test(parameters)) return
  const first = Number.parseInt(parameters.split(";")[0] ?? "", 10)
  const given = Number.isNaN(first) ? 0 : first
  const count = Math.min(Math.max(1, given), widestGrid)
  switch (final) {
    case "K": line.erase(given); break
    case "C": case "a": line.forward(count); break
    case "D": line.back(count); break
    case "G": case "`": line.toColumn(count); break
    case "X": line.eraseCharacters(count); break
    case "P": line.deleteCharacters(count); break
    case "@": line.insertCharacters(count); break
    // Colour, and moves to another row, change nothing the phone draws.
    default: break
  }
}

// Where the next line starts after the first line break the terminal draws
// within reach of from, reading the text from there as plain text. A line
// break inside a control sequence starts a line too, and the text after it
// is read from where the sequence ends.
export function nextLineStart(text: string, from: number, reach: number): number | undefined {
  const reader = new Reader()
  let index = from
  let broken = false
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0
    const char = text.slice(index, index + (code > 0xffff ? 2 : 1))
    const action = reader.step(char, code, index)
    const start = index
    index += char.length
    if (code === 0x0a && action === "execute" && !broken) {
      if (start - from >= reach) return undefined
      broken = true
    }
    // A character that ends a sequence by being text is drawn, so the line
    // starts with it.
    if (broken && reader.state === "ground") return action === "print" ? start : index
    if (!broken && index - from >= reach) return undefined
  }
  return undefined
}

// How the reader stands between two pieces of output. A control sequence
// already malformed, or with an intermediate, stays dropped at its end, and
// a private one stays private.
export type ReaderState = State | "csiDropped" | "csiPrivate"

// The control sequences that change a line, as dispatch acts on them.
const lineFinals = new Set(["K", "C", "a", "D", "G", "`", "X", "P", "@"])

// What one piece of output draws, read on from where the last one left the
// reader: the line breaks the terminal draws in it, whether it draws or moves
// anything on a line, and where it leaves the reader. A piece wholly inside a
// payload, or only a colour, draws nothing.
export function readPiece(state: ReaderState, data: string): { state: ReaderState, lineBreaks: number, draws: boolean } {
  const reader = new Reader()
  if (state === "csi" || state === "csiDropped" || state === "csiPrivate") {
    reader.introduced(0x5b)
    reader.malformed = state === "csiDropped"
    if (state === "csiPrivate") reader.parameters = "?"
    reader.state = "csi"
  } else {
    reader.state = state
  }
  let lineBreaks = 0
  let draws = false
  let index = 0
  for (const char of data) {
    const action = reader.step(char, char.codePointAt(0) ?? 0, index)
    index += char.length
    if (action === "print") draws = true
    else if (action === "dispatch" && lineFinals.has(char) && !/^[<=>?]/.test(reader.parameters)) draws = true
    else if (action === "execute" && (char === "\n" || char === "\r" || char === "\b" || char === "\t")) {
      draws = true
      if (char === "\n") lineBreaks += 1
    }
  }
  if (reader.state !== "csi") return { state: reader.state, lineBreaks, draws }
  const csi: ReaderState = reader.malformed || reader.intermediates !== ""
    ? "csiDropped"
    : /^[<=>?]/.test(reader.parameters) ? "csiPrivate" : "csi"
  return { state: csi, lineBreaks, draws }
}

// Where to cut the front of a text so that what is kept reads as the
// terminal read it. The cut goes after the first line break the terminal
// drew within lineBreakReach past the wanted cut, or, for a line break inside
// a control sequence, where that sequence ends; else at the first place past
// the wanted cut that is plain text, after any sequence it lands in. A
// sequence still arriving there is kept whole from its start when that start
// is within unfinishedReach; past that, the cut stays near the wanted one and
// prefix puts a fresh reader in the state the reader was in at the place it
// resumes, so the rest of the sequence still draws nothing. A control
// sequence whose start is cut is dropped at its end, its parameters being
// lost. What is kept is prefix then text from at, never longer than text
// from cut.
export function readableCut(
  text: string,
  cut: number,
  lineBreakReach: number,
  unfinishedReach: number,
): { at: number, prefix: string } {
  const reader = new Reader()
  let plainAt = cut <= 0 ? 0 : undefined
  // The reader's state at each place a few units past the cut, where a cut
  // inside a sequence still arriving resumes. Places are between whole
  // characters, so the halves of one outside the basic plane stay together.
  const statesPastCut: (State | undefined)[] = []
  let index = 0
  let broken = false
  for (const char of text) {
    const action = reader.step(char, char.codePointAt(0) ?? 0, index)
    const start = index
    index += char.length
    if (char === "\n" && action === "execute" && start >= cut - 1 && index - cut <= lineBreakReach) broken = true
    // A character that ends a sequence by being text is kept.
    if (broken && reader.state === "ground") return { at: action === "print" ? start : index, prefix: "" }
    if (index >= cut && index - cut <= longestReopening) statesPastCut[index - cut] = reader.state
    if (plainAt === undefined && index >= cut && reader.state === "ground") plainAt = index
    if (plainAt !== undefined && !broken && index - cut > lineBreakReach) break
  }
  if (plainAt !== undefined) return { at: plainAt, prefix: "" }
  if (cut - reader.start <= unfinishedReach) return { at: reader.start, prefix: "" }
  // The first place past the cut far enough along to fit what reopens the
  // state there.
  for (const [offset, state] of statesPastCut.entries()) {
    if (state === undefined) continue
    const prefix = reopening[state]
    if (offset >= prefix.length) return { at: cut + offset, prefix }
  }
  return { at: text.length, prefix: reopening[reader.state] }
}

// What puts a fresh reader in each state partway through a sequence. "!" is
// an intermediate, which leaves a control sequence to be dropped at its end.
const reopening: Record<State, string> = {
  ground: "",
  escape: "\u001b",
  escapeIntermediate: "\u001b ",
  csi: "\u001b[!",
  osc: "\u001b]",
  controlString: "\u001bP",
}

// The longest reopening, and one more unit for a character outside the
// basic plane that a place would otherwise split.
const longestReopening = Math.max(...Object.values(reopening).map((prefix) => prefix.length)) + 1

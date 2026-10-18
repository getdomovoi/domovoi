import {
  maximumTerminalReplayCharacters,
  terminalListResultSchema,
  terminalWatchResultSchema,
  type TerminalSummary,
  type TerminalWatchResult,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  claimantLine,
  followAfterOutput,
  followAfterScroll,
  followJump,
  followStart,
  followToggle,
  listedWatches,
  showJump,
  terminalLines,
  terminalLineCount,
  terminalRows,
  terminalSize,
  terminalStatus,
  terminalTitle,
  unconfirmedWatches,
  watchesFor,
  watchFrom,
  withNotification,
  type TerminalWatch,
} from "./terminal-rows"
import { cellWidth } from "./terminal-cell-width"
import { drawnText } from "./terminal-line-model"

// Phone v2 frame 04: what the phone reads from terminal.list and
// terminal.watch, and how it words it. Fixtures go through the protocol's
// own schemas, so a shape the daemon could not send cannot pass here.

const owner = { client: "desktop" as const, clientId: "desktop-1", device: { id: `device-${"a".repeat(32)}`, label: "MacBook Pro" } }

function summary(overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  const [listed] = terminalListResultSchema.parse({
    terminals: [{
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 34,
      shell: "/bin/zsh",
      cwd: "/Users/mira/dev/acme/.domovoi/worktrees/wt-billing-idem",
      owner,
      claimHeld: true,
      openedAt: "2026-10-06T13:52:04.000Z",
      state: "live",
      ...overrides,
    }],
  }).terminals
  return listed!
}

function watched(overrides: Partial<TerminalWatchResult> = {}): TerminalWatchResult {
  return terminalWatchResultSchema.parse({
    ...summary(),
    buffer: "$ pnpm vitest run src/webhooks\n ✓ src/webhooks/handler.spec.ts (14 tests) 412ms\n",
    bufferStartsAt: "2026-10-06T13:52:04.000Z",
    earlierOutputDropped: false,
    watchedAt: "2026-10-06T14:06:12.000Z",
    ...overrides,
  })
}

// Local wall-clock time, as the screen prints it.
function clock(iso: string): string {
  const time = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

const at = new Date("2026-10-06T14:07:18.000Z")

describe("terminalLines", () => {
  it("drops colour and cursor sequences and keeps the words", () => {
    expect(terminalLines("\u001b[32m ✓ passed\u001b[0m\n\u001b]0;title\u0007$ ls\n")).toEqual([" ✓ passed", "$ ls"])
  })

  it("lets a carriage return overwrite the line, as a progress bar does", () => {
    expect(terminalLines("Progress: 10%\rProgress: 100%\r\ndone\n")).toEqual(["Progress: 100%", "done"])
    expect(terminalLines("abcdef\rXY\n")).toEqual(["XYcdef"])
  })

  it("keeps the line still being written, and no empty line after the last newline", () => {
    expect(terminalLines("one\ntwo\n$ ")).toEqual(["one", "two", "$ "])
    expect(terminalLines("one\n")).toEqual(["one"])
    expect(terminalLines("")).toEqual([])
  })

  // Output arrives in pieces, and a piece can end partway through a sequence.
  // Until its end arrives, none of it is drawn.
  it("draws nothing of an escape sequence still arriving at the end", () => {
    expect(terminalLines("red \u001b[31")).toEqual(["red "])
    expect(terminalLines("red \u001b[")).toEqual(["red "])
    expect(terminalLines("$ \u001b]0;my title")).toEqual(["$ "])
    expect(terminalLines("$ \u001b]0;my title\u001b")).toEqual(["$ "])
    expect(terminalLines("red \u001b[31mtext\n")).toEqual(["red text"])
  })

  // A tab moves the cursor to the next stop, every eight columns, without
  // writing over what it passes.
  it("moves a tab to the next tab stop", () => {
    expect(terminalLines("a\tb\n")).toEqual(["a       b"])
    expect(terminalLines("a\tb\rXY\n")).toEqual(["XY      b"])
    expect(terminalLines("abcdefghij\rx\ty\n")).toEqual(["xbcdefghyj"])
  })

  // A backspace only moves the cursor. A shell erases with back, space, back,
  // or with back and an erase to the line's end; a bare backspace erases
  // nothing, and output arriving before the overwrite must not lose cells.
  it("moves the cursor back on a backspace and erases only what is written over", () => {
    expect(terminalLines("lss\b \b\n")).toEqual(["ls "])
    expect(terminalLines("lss\b\u001b[K\n")).toEqual(["ls"])
    expect(terminalLines("abc\b")).toEqual(["abc"])
    expect(terminalLines("abc\bX\n")).toEqual(["abX"])
  })

  // Progress reporters and shells rewrite a line with a carriage return and
  // an erase to its end; what is left on screen is only the new text.
  it("erases what an erase-in-line sequence erases", () => {
    expect(terminalLines("abcdef\rXY\u001b[K\n")).toEqual(["XY"])
    expect(terminalLines("abcdef\rXY\u001b[0K\n")).toEqual(["XY"])
    expect(terminalLines("abcdef\u001b[2K\rdone\n")).toEqual(["done"])
    expect(terminalLines("abcdef\u001b[1K\n")).toEqual([""])
    expect(terminalLines("abcdef\b\b\u001b[1K\n")).toEqual(["     f"])
  })

  // A character outside the basic plane is two UTF-16 units, and a cursor
  // counts it as one cell.
  it("keeps a character outside the basic plane whole", () => {
    expect(terminalLines("🙂 done\n")).toEqual(["🙂 done"])
    expect(terminalLines("ab🙂\rX\n")).toEqual(["Xb🙂"])
  })
})

// #739: a terminal draws a line as cells. A wide character, CJK or a wide
// emoji, takes two; a combining mark takes none and sits on the cell before
// it. Every overwrite, backspace, tab and erase counts in cells.
describe("terminalLines as cells", () => {
  it("counts a wide character as two cells", () => {
    expect(terminalLines("界b\rXY\n")).toEqual(["XYb"])
    expect(terminalLines("🙂b\rXY\n")).toEqual(["XYb"])
    expect(terminalLines("abc\r界\n")).toEqual(["界c"])
    expect(terminalLines("界\tb\n")).toEqual(["界      b"])
  })

  // Writing over either half of a wide character clears all of it, as an
  // erase over either half does.
  it("clears a wide character when half of it is written over or erased", () => {
    expect(terminalLines("界\bX\n")).toEqual([" X"])
    expect(terminalLines("a界\rXY\n")).toEqual(["XY"])
    expect(terminalLines("界界\b\u001b[K\n")).toEqual(["界"])
  })

  it("counts a combining mark as no cell, kept on the character before it", () => {
    // Each accented e below is "e" then U+0301, the combining acute accent.
    expect(terminalLines(`e${String.fromCodePoint(0x301)}b\rXY\n`)).toEqual(["XY"])
    // A mark at the start of a line has no character to sit on.
    expect(terminalLines(`${String.fromCodePoint(0x301)}ab\rX\n`)).toEqual(["Xb"])
    expect(terminalLines("é\n")).toEqual(["é"])
    expect(terminalLines("ébc\rX\n")).toEqual(["Xbc"])
    expect(terminalLines("aé\bX\n")).toEqual(["aX"])
    expect(terminalLines("éb\rXY\n")).toEqual(["XY"])
    // A zero-width joiner and a variation selector take no cell either.
    expect(terminalLines("👍‍🙂\u{fe0f}b\rXYZW\n")).toEqual(["XYZWb"])
  })

  it("names the width of a character from the vendored Unicode table", () => {
    expect(cellWidth("A".codePointAt(0)!)).toBe(1)
    expect(cellWidth("界".codePointAt(0)!)).toBe(2)
    expect(cellWidth("🙂".codePointAt(0)!)).toBe(2)
    expect(cellWidth(0x301)).toBe(0)
    expect(cellWidth(0x200d)).toBe(0)
    // A soft hyphen is drawn, as terminals draw it.
    expect(cellWidth(0xad)).toBe(1)
    // A Hangul medial vowel joins the syllable before it.
    expect(cellWidth(0x1160)).toBe(0)
    // Unassigned code points in the CJK blocks default to wide.
    expect(cellWidth(0x2fffd)).toBe(2)
  })
})

// A terminal moves the cursor along a line with CSI sequences, and a
// progress reporter often redraws with one instead of a carriage return.
describe("terminalLines and cursor movement within a line", () => {
  it("moves to a column, forward and back", () => {
    expect(terminalLines("abc\u001b[2K\u001b[1GX\n")).toEqual(["X"])
    expect(terminalLines("ab\u001b[5Gx\n")).toEqual(["ab  x"])
    expect(terminalLines("abc\u001b[2`X\n")).toEqual(["aXc"])
    expect(terminalLines("abcdef\u001b[3DX\n")).toEqual(["abcXef"])
    expect(terminalLines("abc\u001b[DX\n")).toEqual(["abX"])
    expect(terminalLines("a\u001b[3Cb\n")).toEqual(["a   b"])
    expect(terminalLines("a\u001b[2ab\n")).toEqual(["a  b"])
    expect(terminalLines("ab\u001b[9Dx\n")).toEqual(["xb"])
  })

  it("erases, deletes and inserts cells at the cursor", () => {
    expect(terminalLines("abcdef\r\u001b[2X\n")).toEqual(["  cdef"])
    expect(terminalLines("abcdef\r\u001b[2P\n")).toEqual(["cdef"])
    expect(terminalLines("abc\r\u001b[2@\n")).toEqual(["  abc"])
  })

  // Half of a wide character erased, deleted or split takes the whole of it.
  it("clears a wide character an erase, a delete or an insert splits", () => {
    expect(terminalLines("界b\r\u001b[C\u001b[X\n")).toEqual(["  b"])
    expect(terminalLines("a界b\r\u001b[C\u001b[P\n")).toEqual(["a b"])
    expect(terminalLines("a界b\r\u001b[2C\u001b[P\n")).toEqual(["a b"])
    expect(terminalLines("a界b\r\u001b[2C\u001b[@\n")).toEqual(["a   b"])
    expect(terminalLines("a界b\r\u001b[C\u001b[@\n")).toEqual(["a 界b"])
  })

  // Inserting and deleting act on the cursor's row of the widest grid, so a
  // record of them cannot grow a line past it or move a long line's whole
  // tail each time.
  it("bounds what inserting and deleting characters cost", () => {
    const inserted = terminalLines(`x\r${"\u001b[1000@".repeat(9_362)}y`)
    expect(inserted).toEqual(["y"])
    // What passes the row's end is lost, as at a terminal's right margin.
    expect(terminalLines("abc\r\u001b[998@\n")).toEqual([`${" ".repeat(998)}ab`])
    const deleted = terminalLines(`${"x".repeat(40_000)}\r${"\u001b[P".repeat(8_000)}`)
    expect(deleted).toEqual([`${" ".repeat(1_000)}${"x".repeat(39_000)}`])
    // Blanks pushed along a line are nothing to move.
    expect(terminalLines(`x\r${"\u001b[@".repeat(21_844)}`)).toEqual([])
    // An insert in a long line's first row leaves the next row where it was.
    expect(terminalLines(`${"x".repeat(1_500)}\r\u001b[2@\n`)).toEqual([`  ${"x".repeat(1_498)}`])
    // A wide character across the row's end cannot move as one, so it goes.
    expect(terminalLines(`${"a".repeat(999)}界\r\u001b[@\n`)).toEqual([` ${"a".repeat(999)}`])
  })

  // A record made of character edits costs about what a record of plain
  // output costs to read. Timed against plain text on the same machine, best
  // of five, so a loaded runner slows both sides alike. Measured with Node 26
  // on an Apple Silicon Mac, as multiples of the plain read: inserts and
  // deletes moved cell by cell took 14 to 23 times, erases 26 times; in rows
  // with the array's own splice and fill, at most 4.1 and 1.4 times. The
  // bound of 10 sits between the two.
  it("reads a record of inserts, deletes and erases about as fast as plain output", () => {
    const best = (text: string) => {
      let fastest = Infinity
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now()
        drawnText(text)
        fastest = Math.min(fastest, performance.now() - started)
      }
      return fastest
    }
    const plain = best("\u001b[32m ✓\u001b[0m src/webhooks/handler.spec.ts (14 tests) 412ms\r\n".repeat(900))
    const insertsAndDeletes = best(`${"x".repeat(999)}\r${"\u001b[@\u001b[P".repeat(10_756)}`)
    const erases = best(`\u001b[998Cx\r${"\u001b[997X".repeat(10_900)}`)
    expect(insertsAndDeletes / plain).toBeLessThan(10)
    expect(erases / plain).toBeLessThan(10)
  })

  // #808: cursor moves and inserts add blanks past what was written, a
  // thousand for a few characters each time. Across one text they may add
  // no more than one record's worth, so what is drawn stays near the size of
  // what arrived.
  it("bounds the blanks moves and inserts add across a text", () => {
    const drawnSize = (text: string) => drawnText(text).lines.reduce((size, line) => size + line.length, 0)
    const moves = "\u001b[1000Cx\n".repeat(7_281)
    expect(drawnSize(moves)).toBeLessThanOrEqual(moves.length * 2 + 65_536)
    const inserts = "x\r\u001b[999@\n".repeat(6_553)
    expect(drawnSize(inserts)).toBeLessThanOrEqual(inserts.length * 2 + 65_536)
    // Once spent, a move past what was written stops at its end.
    expect(drawnText(`${"\u001b[1000Cx\n".repeat(66)}\u001b[5Cy\n`).lines.at(-2)).toBe("y")
    // An insert cut short at the old end takes a wide character it splits.
    expect(drawnText(`${"\u001b[1000Cx\n".repeat(66)}界\r\u001b[@\u001b[3GX\n`).lines.at(-2)).toBe("  X")
  })

  // An erase to the cursor erases the whole line before it, however long.
  it("erases a line longer than the widest grid to the cursor", () => {
    expect(terminalLines(`${"a".repeat(1_000)}b\u001b[1K\n`)).toEqual([""])
    expect(terminalLines(`${"a".repeat(1_000)}bcd\u001b[2D\u001b[1K\n`)).toEqual([`${" ".repeat(1_002)}d`])
    // An erase after one already made erases what was written since.
    expect(terminalLines("abcd\u001b[1Kxy\r\u001b[4C\u001b[1K\n")).toEqual(["     y"])
  })

  // Lines are read once per text and handed out as copies.
  it("hands out lines a caller can change", () => {
    const first = terminalLines("a\nb\n")
    first.push("x")
    expect(terminalLines("a\nb\n")).toEqual(["a", "b"])
  })

  // A private marker after a parameter makes the sequence malformed.
  it("drops a malformed sequence", () => {
    expect(terminalLines("abc\r\u001b[2?KX\n")).toEqual(["Xbc"])
  })

  // The phone draws lines, not a screen. Moving to another row is dropped,
  // and what follows is drawn where the cursor was on this line.
  it("drops movement to another row", () => {
    expect(terminalLines("\u001b[2J\u001b[1;1Hhello\n")).toEqual(["hello"])
  })
})

// F17: zsh with a starship prompt and zsh-autosuggestions, recorded from a
// pty at a 40 column grid and cut down. Typing "w" shows the rest of a
// history entry in grey; it runs past the grid onto a second row, so zsh
// moves back up a row and along to the cursor. On Enter it erases both rows
// of the suggestion and reaches the row below with a move down and a carriage
// return, not a line break, and only then does the command print.
const zshPrompt = "\u001b[38;2;166;218;149m\u{F011B}\u001b[38;2;245;169;127m ❯\u001b[0m \u001b[K\u001b[?1h\u001b=\u001b[?2004h"
const zshTyped = [
  "w",
  "\b\u001b[32mw\u001b[39m\u001b[90mhoami && echo staging-deploy-finished\u001b[39m\u001b[K\u001b[A\u001b[3C",
  "\u001b[32mh\u001b[39m",
  "\u001b[32mo\u001b[39m",
  "\u001b[32ma\u001b[39m",
  "\u001b[32mm\u001b[39m",
  "\u001b[32mi\u001b[39m",
  "\b\b\b\b\b\b\u001b[32mwhoami\u001b[39m",
].join("")
const zshEnter = [
  "\u001b[K\u001b[1B\r\u001b[K\u001b[A\u001b[10C",
  "\u001b[?1l\u001b>\u001b[?2004l",
  "\u001b[1B\r",
  "\u001b]2;whoami\u0007",
  "fetzy\r\n",
  `\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m${" ".repeat(39)}\r \r`,
  "\r\u001b[0m\u001b[27m\u001b[24m\u001b[J\r\n~/walk on main\r\n",
  zshPrompt,
].join("")

describe("terminalLines at the holder's grid", () => {
  it("keeps a command and its output on their own lines when zsh moves between rows", () => {
    const text = `~/walk on main\r\n${zshPrompt}${zshTyped}${zshEnter}`
    expect(terminalLines(`~/walk on main\r\n${zshPrompt}${zshTyped}`, 40)).toEqual([
      "~/walk on main",
      "\u{F011B} ❯ whoami && echo staging-deploy-finished",
    ])
    expect(terminalLines(text, 40)).toEqual([
      "~/walk on main",
      "\u{F011B} ❯ whoami",
      "fetzy",
      " ".repeat(40),
      "~/walk on main",
      "\u{F011B} ❯ ",
    ])
  })

  it("returns a carriage return to the start of the cursor's row", () => {
    expect(terminalLines(`${"a".repeat(12)}\rX\n`, 5)).toEqual([`${"a".repeat(10)}Xa`])
    // Exactly a row printed leaves the cursor on that row, at its last cell.
    expect(terminalLines("abcde\rX\n", 5)).toEqual(["Xbcde"])
    expect(terminalLines("abcde\u001b[KX\n", 5)).toEqual(["abcdX"])
    // Without the grid the whole line is one row, as before.
    expect(terminalLines(`${"a".repeat(12)}\rX\n`)).toEqual([`X${"a".repeat(11)}`])
  })

  it("moves up and down the rows of one wrapped line", () => {
    // Rows "abcde" and "fgh": up to column 3, X, then down to column 4 of
    // the second row, past its text.
    expect(terminalLines("abcdefgh\u001b[AX\u001b[BY\n", 5)).toEqual(["abcXefgh Y"])
    // A move does not leave the row it starts on sideways.
    expect(terminalLines("abcdefgh\u001b[9DX\n", 5)).toEqual(["abcdeXgh"])
    expect(terminalLines("abcdefgh\u001b[AY\u001b[9CX\n", 5)).toEqual(["abcYXfgh"])
    expect(terminalLines("abcdefgh\u001b[1GX\n", 5)).toEqual(["abcdeXgh"])
  })

  it("starts the next line on a move down past the line, once however far", () => {
    expect(terminalLines("abc\u001b[BX\n", 5)).toEqual(["abc", "   X"])
    expect(terminalLines("abc\u001b[999B\rX\n", 5)).toEqual(["abc", "X"])
    expect(terminalLines("abc\u001b[E\u001b[EX\n", 5)).toEqual(["abc", "", "X"])
  })

  // The phone keeps no screen, so a move up past the line's first row is
  // dropped, and a move down after it only undoes that.
  it("drops a move up past the line, and the move down that undoes it", () => {
    expect(terminalLines("one\r\ntwo\u001b[A\rX\u001b[B\rY\n", 5)).toEqual(["one", "Ywo"])
    expect(terminalLines("one\r\ntwo\u001b[A\u001b[2B\rY\n", 5)).toEqual(["one", "two", "Y"])
  })

  it("erases to the end of the cursor's row, not of the whole line", () => {
    expect(terminalLines("abcdefgh\u001b[A\u001b[K\n", 5)).toEqual(["abc  fgh"])
    expect(terminalLines("abcdefgh\u001b[A\u001b[1K\n", 5)).toEqual(["    efgh"])
    expect(terminalLines("abcdefgh\u001b[A\u001b[2K\n", 5)).toEqual(["     fgh"])
    expect(terminalLines("abcdefgh\u001b[2K\n", 5)).toEqual(["abcde"])
  })

  // The walk: the phone watched while the prompt held the typed command, so
  // the record ended mid-line and Enter arrived live. The output printed over
  // the command line ("fetzy    whoami") instead of under it.
  it("draws a command the record ended on once, above its live output, at the holder's grid", () => {
    const watchedAt = "2026-10-15T23:22:26.000Z"
    const record = withNotification(
      watchFrom(watched({ cols: 40, buffer: `~/walk on main\r\n${zshPrompt}${zshTyped}`, watchedAt })),
      { method: "terminal.output", params: { terminalId: "terminal-1", data: zshEnter } },
      at,
    )
    expect(terminalRows(record, true).map((row) => row.text)).toEqual([
      "~/walk on main",
      `Recent output above. Live from ${clock(watchedAt)}.`,
      "\u{F011B} ❯ whoami",
      "fetzy",
      " ".repeat(40),
      "~/walk on main",
      "\u{F011B} ❯ ",
    ])
    expect(terminalLineCount(record)).toBe(6)
  })
})

// Strings a terminal reads and never draws: a Device Control String such as
// sixel graphics, an application program command, a privacy message, a start
// of string. Each runs to the string terminator, ESC then backslash.
describe("terminalLines and control strings", () => {
  it("draws nothing of a control string's payload", () => {
    expect(terminalLines("before\u001bPq#0;2;0;0;0#0~~@@vv\u001b\\after\n")).toEqual(["beforeafter"])
    expect(terminalLines("a\u001b_Gf=100;payload\u001b\\b\n")).toEqual(["ab"])
    expect(terminalLines("a\u001b^private\u001b\\b\n")).toEqual(["ab"])
    expect(terminalLines("a\u001bXstring\u001b\\b\n")).toEqual(["ab"])
    // A bell ends a window title but not a device control string.
    expect(terminalLines("a\u001bPpay\u0007load\u001b\\b\n")).toEqual(["ab"])
  })

  it("draws nothing of a control string still arriving", () => {
    expect(terminalLines("a\u001bPpartial")).toEqual(["a"])
    expect(terminalLines("a\u001bPpartial\u001b")).toEqual(["a"])
  })

  // A line break inside a payload is not a line on screen.
  it("starts no line for a line break inside a payload", () => {
    expect(terminalLines("a\u001bPx\ny\u001b\\b\n")).toEqual(["ab"])
  })

  // An 8-bit control is the escape it stands for, and CAN or SUB abandons a
  // sequence partway.
  it("reads 8-bit controls and drops an abandoned sequence", () => {
    expect(terminalLines("abc\u009b2Dx\n")).toEqual(["axc"])
    expect(terminalLines("a\u0090payload\u009cb\n")).toEqual(["ab"])
    expect(terminalLines("a\u009d0;title\u0007b\n")).toEqual(["ab"])
    expect(terminalLines("a\u001b[31\u0018b\n")).toEqual(["ab"])
    expect(terminalLines("a\u001bPpay\u001ab\n")).toEqual(["ab"])
    // An 8-bit control inside a string ends it and begins its own sequence.
    expect(terminalLines("a\u001bPqdata\u009b2CX\n")).toEqual(["a  X"])
    // Mode changes, such as hiding the cursor, move nothing.
    expect(terminalLines("a\u001b[?25lb\u001b[?2004h\n")).toEqual(["ab"])
  })

  // A character set choice, as tput sgr0 sends, is three characters.
  it("draws nothing of a character set choice", () => {
    expect(terminalLines("\u001b(Bok\u001b(0\u001b[m\n")).toEqual(["ok"])
  })
})

describe("terminalTitle and terminalSize", () => {
  it("names the shell and the directory it runs in, and the claimant's size", () => {
    expect(terminalTitle(summary())).toBe("zsh · wt-billing-idem")
    expect(terminalTitle(summary({ shell: "C:\\Windows\\System32\\cmd.exe", cwd: "C:\\src\\acme\\" }))).toBe("cmd.exe · acme")
    expect(terminalSize(summary())).toBe("120×34")
  })
})

describe("terminalStatus", () => {
  it("reads Live, Failed and Closed from the state and the exit code", () => {
    expect(terminalStatus(summary(), true)).toEqual({ label: "Live", tone: "live" })
    expect(terminalStatus(summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 1 }), true))
      .toEqual({ label: "Failed", tone: "failed" })
    expect(terminalStatus(summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 0 }), true))
      .toEqual({ label: "Closed", tone: "closed" })
    // Ended by a signal is how a desktop closing the shell looks. It is not a failure.
    expect(terminalStatus(summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", signal: 1 }), true))
      .toEqual({ label: "Closed", tone: "closed" })
  })

  // 04d: a dropped connection is unconfirmed, not failed.
  it("says Unconfirmed while the connection is down, whatever was last heard", () => {
    expect(terminalStatus(summary(), false)).toEqual({ label: "Unconfirmed", tone: "unconfirmed" })
  })
})

describe("claimantLine", () => {
  it("names the device that holds the claim", () => {
    expect(claimantLine(summary(), true)).toBe("Claimed by MacBook Pro")
  })

  it("says last claimed when the shell closed or its claimant is gone", () => {
    expect(claimantLine(summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 0 }), true))
      .toBe("Last claimed by MacBook Pro")
    expect(claimantLine(summary({ claimHeld: false }), true)).toBe("Last claimed by MacBook Pro")
  })

  it("says what was last heard while the connection is down", () => {
    expect(claimantLine(summary(), false)).toBe("Last heard: claimed by MacBook Pro")
  })

  // A root bearer has no paired device, so its client kind is what is known.
  it("names the client kind when the claimant has no paired device", () => {
    expect(claimantLine(summary({ owner: { client: "desktop", clientId: "desktop-1" } }), true)).toBe("Claimed by a desktop client")
  })
})

describe("terminalRows", () => {
  it("shows the recent output, then marks where live output starts", () => {
    const record = watchFrom(watched())
    expect(terminalRows(record, true)).toEqual([
      { kind: "line", key: "line-0", text: "$ pnpm vitest run src/webhooks" },
      { kind: "line", key: "line-1", text: " ✓ src/webhooks/handler.spec.ts (14 tests) 412ms" },
      { kind: "mark", key: "live-from", text: `Recent output above. Live from ${clock("2026-10-06T14:06:12.000Z")}.` },
    ])
  })

  // The record can stop mid-line, mid-sequence or mid-overwrite, and live
  // output carries on from exactly there.
  it("reads a line that spans the record and live output as one line, under the mark", () => {
    const output = (record: ReturnType<typeof watchFrom>, data: string) =>
      withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, at)
    const split = output(watchFrom(watched({ buffer: "first\n$ hel" })), "lo\n")
    expect(terminalRows(split, true).map((row) => row.text)).toEqual([
      "first",
      `Recent output above. Live from ${clock("2026-10-06T14:06:12.000Z")}.`,
      "$ hello",
    ])
    const sequence = output(watchFrom(watched({ buffer: "a\n\u001b[3" })), "2mgreen\u001b[0m\n")
    expect(terminalRows(sequence, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["a", "green"])
    const overwrite = output(watchFrom(watched({ buffer: "Progress 10%" })), "\rProgress 100%\n")
    expect(terminalRows(overwrite, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["Progress 100%"])
  })

  // 04c: the machine did not keep the start, and the view says where it starts.
  it("says where the machine's record starts when earlier output was dropped", () => {
    const rows = terminalRows(watchFrom(watched({ earlierOutputDropped: true })), true)
    expect(rows[0]).toEqual({
      kind: "mark",
      key: "machine-dropped",
      text: `Earlier output was not kept. The machine's record of this terminal starts at ${clock("2026-10-06T13:52:04.000Z")}.`,
    })
  })

  it("appends live output under the mark", () => {
    const record = withNotification(watchFrom(watched()), { method: "terminal.output", params: { terminalId: "terminal-1", data: " ❯ replay.spec.ts (5 tests | 1 failed)\n" } }, at)
    expect(terminalRows(record, true).at(-1)).toEqual({ kind: "line", key: "line-2", text: " ❯ replay.spec.ts (5 tests | 1 failed)" })
    expect(terminalLineCount(record)).toBe(3)
    expect(record.received).toBe(1)
  })

  // 04b: closed is a state, and the end is stated with its exit code.
  it("states how the shell ended, from the closed notification", () => {
    const record = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 0 } }, at)
    expect(record.summary.state).toBe("closed")
    expect(record.summary.claimHeld).toBe(false)
    expect(terminalRows(record, true).at(-1)).toEqual({
      kind: "mark",
      key: "closed",
      text: "The shell exited with code 0. No more output will arrive.",
    })
    const signalled = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", signal: 1 } }, at)
    expect(terminalRows(signalled, true).at(-1)?.text).toBe("The shell ended on signal 1. No more output will arrive.")
    const unexplained = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1" } }, at)
    expect(terminalRows(unexplained, true).at(-1)?.text).toBe("The shell closed. No more output will arrive.")
  })

  // The daemon sends the exit code with the signal for a shell it killed,
  // and a signal of 0 for one that exited on its own.
  it("names the signal over the exit code, and calls a signalled shell Closed", () => {
    const killed = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 1, signal: 15 } }, at)
    expect(terminalRows(killed, true).at(-1)?.text).toBe("The shell ended on signal 15. No more output will arrive.")
    expect(terminalStatus(killed.summary, true)).toEqual({ label: "Closed", tone: "closed" })
    const exited = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 2, signal: 0 } }, at)
    expect(terminalRows(exited, true).at(-1)?.text).toBe("The shell exited with code 2. No more output will arrive.")
    expect(terminalStatus(exited.summary, true)).toEqual({ label: "Failed", tone: "failed" })
  })

  // The notification carries no time, and the phone's clock is not the
  // daemon's. The time comes with the daemon's list.
  it("states no close time until the daemon's list gives one", () => {
    const closed = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 0 } }, at)
    expect(closed.summary.closedAt).toBeUndefined()
    const listed = listedWatches(new Map([["terminal-1", { state: "watching", record: closed }]]), [
      summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 0 }),
    ]).get("terminal-1")
    if (listed?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(terminalRows(listed.record, true).at(-1)?.text).toBe(`The shell exited with code 0 at ${clock("2026-10-06T14:09:40.000Z")}. No more output will arrive.`)
  })

  it("does not claim live output for a terminal that was already closed when watched", () => {
    const record = watchFrom(watched({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 2 }))
    const rows = terminalRows(record, true)
    expect(rows.map((row) => row.key)).toEqual(["line-0", "line-1", "closed"])
    expect(rows.at(-1)?.text).toBe(`The shell exited with code 2 at ${clock("2026-10-06T14:09:40.000Z")}. No more output will arrive.`)
  })

  // 04d: the gap is marked where it began.
  it("marks when output was last heard while the connection is down", () => {
    const record = withNotification(watchFrom(watched()), { method: "terminal.output", params: { terminalId: "terminal-1", data: "x\n" } }, at)
    expect(terminalRows(record, false).at(-1)).toEqual({
      kind: "mark",
      key: "dropped",
      text: `Nothing received since ${clock(at.toISOString())}. Reconnecting replays the recent output first.`,
    })
  })

  it("keeps no more than the machine keeps, and says the phone dropped the start", () => {
    const line = `${"x".repeat(99)}\n`
    let record = watchFrom(watched({ buffer: line.repeat(10) }))
    for (let index = 0; index < Math.ceil(maximumTerminalReplayCharacters / line.length) + 5; index += 1) {
      record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: line } }, at)
    }
    expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
    const rows = terminalRows(record, true)
    expect(rows[0]).toEqual({ kind: "mark", key: "phone-dropped", text: "Earlier output was not kept on this phone." })
    expect(rows.filter((row) => row.kind === "line").every((row) => row.text === "x".repeat(99))).toBe(true)
    // Counted as it arrived, so cutting the front does not stop the count.
    expect(record.received).toBe(Math.ceil(maximumTerminalReplayCharacters / line.length) + 5)
  })

  // A cut at the bound never splits a character in two.
  // A cut inside an escape sequence would leave its parameters, "[31m", to
  // be drawn as text.
  it("cuts at the bound without splitting an escape sequence", () => {
    const full = watchFrom(watched({ buffer: `\u001b[31m${"x".repeat(maximumTerminalReplayCharacters - 5)}` }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y" } }, at)
    expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
    expect(terminalLines(record.text)[0]?.startsWith("x")).toBe(true)
  })

  // The daemon keeps its record by size and can start it anywhere, even
  // inside an escape sequence. A record that does not start at the shell's
  // start begins with the rest of a line, which is not drawn.
  // A window title can run to hundreds of characters, and a cut inside it
  // would draw the title as output.
  it("cuts at the bound past a long operating system command", () => {
    const title = `\u001b]0;${"t".repeat(120)}\u0007`
    const full = watchFrom(watched({ buffer: `${title}${"x".repeat(maximumTerminalReplayCharacters - title.length)}` }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y".repeat(80) } }, at)
    expect(terminalLines(record.text)[0]?.startsWith("x")).toBe(true)
  })

  // A device control string, such as sixel graphics, can run far longer
  // than a title, and a cut inside it would draw its payload as text.
  it("cuts at the bound past a long device control string", () => {
    const graphics = `\u001bPq${"#0~".repeat(400)}\u001b\\`
    const full = watchFrom(watched({ buffer: `${graphics}${"x".repeat(maximumTerminalReplayCharacters - graphics.length)}` }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y".repeat(80) } }, at)
    expect(terminalLines(record.text)[0]?.startsWith("x")).toBe(true)
  })

  // A line break inside a payload is not a line to cut after, and an 8-bit
  // introducer opens a string as ESC and its letter do.
  it("cuts at the bound past a control string with a line break or an 8-bit introducer", () => {
    for (const [head, data] of [["\u001bPqaaa\nPAYLOAD\u001b\\", "y"], ["\u0090qPAYLOAD\u009c", "yy"]] as const) {
      const full = watchFrom(watched({ buffer: `${head}${"x".repeat(maximumTerminalReplayCharacters - head.length)}` }))
      const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, at)
      expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
      expect(terminalLines(record.text).join("\n")).not.toContain("PAYLOAD")
    }
  })

  // A control string longer than the reach for keeping one whole is cut at
  // the bound, and the rest of its payload still draws nothing.
  it("keeps drawing nothing of a control string cut past the reach for keeping it whole", () => {
    let record = watchFrom(watched({ buffer: `\u001bPq${"#".repeat(maximumTerminalReplayCharacters - 3)}` }))
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: "#".repeat(4_097) } }, at)
    expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
    expect(terminalLines(record.text)).toEqual([])
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: "\u001b\\done\n" } }, at)
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["done"])
  })

  // An escape still waiting for its second character when the cut passes
  // the reach is waiting for it after the cut too.
  it("keeps an escape cut past the reach waiting for its second character", () => {
    let record = watchFrom(watched({ buffer: `\u001b${"\u0000".repeat(maximumTerminalReplayCharacters - 1)}` }))
    for (const data of ["\u0000".repeat(4_097), "]0;PAYLOAD\u0007done\n"]) {
      record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, at)
    }
    expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["done"])
  })

  // #808: a line break inside a control sequence still starts a line, and
  // the text after it is read once the sequence ends.
  it("skips the first line to a line break made inside a control sequence", () => {
    const lines = (buffer: string) => terminalRows(watchFrom(watched({ buffer, earlierOutputDropped: true })), true)
      .filter((row) => row.kind === "line").map((row) => row.text)
    expect(lines("partial\u001b[31\nmred\nnext\n")).toEqual(["red", "next"])
    // A character that ends a sequence by being text is drawn.
    expect(lines("partial\u001b[\nétext\n")).toEqual(["étext"])
    // Only the first line break has to be near; the sequence can run on.
    expect(lines(`partial\u001b[\n${"1".repeat(300)}\nmnext\n`)).toEqual(["next"])
    const head = `${"x".repeat(100)}abc\u001b[31\nmred`
    const full = watchFrom(watched({ buffer: `${head}${"z".repeat(maximumTerminalReplayCharacters - head.length)}` }))
    const cut = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y".repeat(101) } }, at)
    expect(terminalLines(cut.text)[0]?.startsWith("redz")).toBe(true)
  })

  // The first line of a record the daemon cut is skipped to a line break
  // the terminal draws, not one inside a payload.
  it("does not skip to a line break inside a payload when the record starts mid-line", () => {
    const head = "lead\u001bPq\nPAYLOAD"
    const full = watchFrom(watched({ buffer: `${head}${"#".repeat(maximumTerminalReplayCharacters - head.length)}`, earlierOutputDropped: true }))
    expect(terminalRows(full, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["lead"])
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "#" } }, at)
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["ead"])
  })

  // The cut resumes in the state the reader was in where it resumes, not in
  // the state at the end of the text: here an escape, which the "[" after
  // the cut turns into a control sequence that draws nothing.
  it("resumes a cut sequence in the state at the cut, not at the end", () => {
    let record = watchFrom(watched({ buffer: `\u001b${"\u0000".repeat(maximumTerminalReplayCharacters - 1)}` }))
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: `${"\u0000".repeat(4_093)}[123` } }, at)
    expect(record.text.length).toBeLessThanOrEqual(maximumTerminalReplayCharacters)
    expect(terminalRows(record, true).filter((row) => row.kind === "line")).toEqual([])
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: "mdone\n" } }, at)
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["done"])
  })

  // A line break inside a control string's payload is not a line, so the
  // live mark goes under the last line the record drew.
  it("places the live mark by the lines drawn, not the line breaks inside a payload", () => {
    const record = withNotification(watchFrom(watched({ buffer: "first\n\u001bPa\nb\u001b\\" })), { method: "terminal.output", params: { terminalId: "terminal-1", data: "next\n" } }, at)
    expect(terminalRows(record, true).map((row) => row.kind === "mark" ? row.key : row.text)).toEqual(["first", "live-from", "next"])
  })

  // A command still arriving at the cut is kept whole until it ends.
  it("keeps an unfinished operating system command whole across a cut", () => {
    let record = watchFrom(watched({ buffer: `\u001b]0;${"t".repeat(maximumTerminalReplayCharacters - 4)}` }))
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: "tt" } }, at)
    record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data: "\u0007done\n" } }, at)
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["done"])
  })

  // The two-character end of a title, ESC then backslash, can arrive in two
  // pieces of output.
  it("keeps an unfinished title whole when its end arrives split", () => {
    let record = watchFrom(watched({ buffer: `\u001b]0;${"t".repeat(maximumTerminalReplayCharacters - 4)}` }))
    for (const data of ["tt", "\u001b", "\\done\n"]) {
      record = withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, at)
    }
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["done"])
  })

  // The phone's cut is sequence-safe only for what it can see. A title whose
  // introducer the daemon already cut stays hidden until the cut passes it.
  it("keeps hiding a title the daemon cut into when the phone cuts before its end", () => {
    const head = `${"t".repeat(300)}\u0007out\n`
    const full = watchFrom(watched({ buffer: `${head}${"x".repeat(maximumTerminalReplayCharacters - head.length)}`, earlierOutputDropped: true }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y" } }, at)
    const lines = terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)
    expect(lines.some((line) => line.includes("t"))).toBe(false)
  })

  // The daemon's record can start inside a window title.
  it("does not draw the rest of a window title a record starts inside", () => {
    const record = watchFrom(watched({ buffer: `${"t".repeat(300)}\u0007prompt\nnext\n`, earlierOutputDropped: true }))
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["next"])
  })

  it("drops the partial first line of a record whose start the daemon did not keep", () => {
    const record = watchFrom(watched({ buffer: "1mred text\u001b[0m\nnext line\n", earlierOutputDropped: true }))
    expect(terminalRows(record, true).filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["next line"])
    expect(terminalLineCount(record)).toBe(1)
    // A record kept from the shell's start is drawn whole.
    expect(terminalLineCount(watchFrom(watched({ buffer: "1mred text\nnext line\n" })))).toBe(2)
  })

  it("cuts at the bound without splitting a character outside the basic plane", () => {
    const full = watchFrom(watched({ buffer: `🙂${"x".repeat(maximumTerminalReplayCharacters - 2)}` }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y" } }, at)
    expect(record.text.startsWith("x")).toBe(true)
    expect(record.text.endsWith("xy")).toBe(true)
  })

  // Output with no line break, a progress bar or a minified dump, is cut at
  // the bound rather than all at once.
  it("keeps the newest output up to the bound when there is no line break to cut at", () => {
    const full = watchFrom(watched({ buffer: "x".repeat(maximumTerminalReplayCharacters) }))
    const record = withNotification(full, { method: "terminal.output", params: { terminalId: "terminal-1", data: "y" } }, at)
    expect(record.text.length).toBe(maximumTerminalReplayCharacters)
    expect(record.text.endsWith("xy")).toBe(true)
  })

  // After a reconnect the daemon's list is current, and the output on screen
  // is not until the new watch answers.
  it("marks the gap on a record kept across a reconnect until it is watched again", () => {
    const kept = withNotification(watchFrom(watched()), { method: "terminal.output", params: { terminalId: "terminal-1", data: "x\n" } }, at)
    const relisted = listedWatches(unconfirmedWatches(new Map([["terminal-1", { state: "watching", record: kept }]])), [summary()]).get("terminal-1")
    if (relisted?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(terminalRows(relisted.record, true).at(-1)?.key).toBe("dropped")
  })

  // A list after a reconnect can say the shell closed while the phone was
  // away. The output held is the old connection's, so the gap is still said.
  it("marks the gap before the end on a record the list says closed", () => {
    const kept = watchFrom(watched())
    const closed = summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 1 })
    const relisted = listedWatches(unconfirmedWatches(new Map([["terminal-1", { state: "watching", record: kept }]])), [closed]).get("terminal-1")
    if (relisted?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(terminalRows(relisted.record, true).slice(-2).map((row) => row.key)).toEqual(["dropped", "closed"])
  })

  // The end arrived on this record, so nothing is missing after it, whatever
  // the connection does next.
  it("says nothing is missing from a shell whose end it heard", () => {
    const closed = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 0 } }, at)
    expect(terminalRows(closed, false).map((row) => row.key)).not.toContain("dropped")
  })

  // A record can end on a line break followed by a colour reset.
  it("places the live mark after a finished line that ends in an escape sequence", () => {
    const record = withNotification(watchFrom(watched({ buffer: "finished\n\u001b[0m" })), { method: "terminal.output", params: { terminalId: "terminal-1", data: "next\n" } }, at)
    expect(terminalRows(record, true).map((row) => row.kind === "mark" ? row.key : row.text)).toEqual(["finished", "live-from", "next"])
  })

  // The record can end with an erased line and a sequence cut in half, which
  // live output finishes.
  it("places the live mark after the last finished line when the record ends mid-sequence", () => {
    const record = withNotification(watchFrom(watched({ buffer: "first\n\u001b[2K\u001b[31" })), { method: "terminal.output", params: { terminalId: "terminal-1", data: "mnext\n" } }, at)
    expect(terminalRows(record, true).map((row) => row.kind === "mark" ? row.key : row.text)).toEqual(["first", "live-from", "next"])
  })
})

describe("withNotification", () => {
  // #808: a line break inside a payload is no line for the reader to catch
  // up on, and a piece that draws nothing is no output below them.
  it("counts only the line breaks and pieces the terminal draws", () => {
    const output = (record: ReturnType<typeof watchFrom>, data: string) =>
      withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, at)
    const payload = output(watchFrom(watched()), "\u001bPa\nb\u001b\\")
    expect(payload.received).toBe(0)
    expect(payload.pieces).toBe(0)
    // A payload can start in one piece and end in the next.
    const split = output(output(watchFrom(watched()), "\u001bPa"), "\nb\u001b\\")
    expect(split.received).toBe(0)
    expect(split.pieces).toBe(0)
    const drawn = output(split, "done\n")
    expect(drawn.received).toBe(1)
    expect(drawn.pieces).toBe(1)
    // A malformed sequence ended in a later piece is still dropped, and a
    // colour alone draws nothing.
    const malformed = output(output(watchFrom(watched()), "\u001b[1 2"), "m")
    expect(malformed.pieces).toBe(0)
    // A private sequence split after its marker moves nothing either.
    expect(output(output(watchFrom(watched()), "\u001b[?"), "2C").pieces).toBe(0)
    expect(output(output(watchFrom(watched()), "\u001b["), "2C").pieces).toBe(1)
    expect(output(watchFrom(watched()), "\u001b[31m").pieces).toBe(0)
  })

  it("moves the claimant line when the claim moves", () => {
    const record = withNotification(
      watchFrom(watched({ claimHeld: false })),
      { method: "terminal.ownership", params: { terminalId: "terminal-1", owner: { client: "web", clientId: "web-1", device: { id: `device-${"b".repeat(32)}`, label: "Studio" } } } },
      at,
    )
    expect(claimantLine(record.summary, true)).toBe("Claimed by Studio")
  })

  // A release names the last holder with the claim no longer held.
  it("says the claim was given up when the holder releases it", () => {
    const record = withNotification(
      watchFrom(watched()),
      { method: "terminal.ownership", params: { terminalId: "terminal-1", owner: { client: "web", clientId: "web-1", device: { id: `device-${"b".repeat(32)}`, label: "Studio" } }, claimHeld: false } },
      at,
    )
    expect(record.summary.claimHeld).toBe(false)
    expect(claimantLine(record.summary, true)).toBe("Last claimed by Studio")
  })

  // A claim that moved is something heard, so a gap after it starts there.
  it("hears a move of the claim as recently as any output", () => {
    const later = new Date("2026-10-06T14:30:00.000Z")
    const record = withNotification(
      watchFrom(watched()),
      { method: "terminal.ownership", params: { terminalId: "terminal-1", owner: { client: "web", clientId: "web-1", device: { id: `device-${"b".repeat(32)}`, label: "Studio" } } } },
      later,
    )
    expect(record.lastHeardAt).toBe(later.toISOString())
    expect(terminalRows(record, false).at(-1)?.text).toBe(`Nothing received since ${clock(later.toISOString())}. Reconnecting replays the recent output first.`)
  })

  it("leaves a record alone for another terminal's notification", () => {
    const record = watchFrom(watched())
    expect(withNotification(record, { method: "terminal.output", params: { terminalId: "terminal-2", data: "elsewhere\n" } }, at)).toBe(record)
  })

  it("adds nothing after the shell closed", () => {
    const closed = withNotification(watchFrom(watched()), { method: "terminal.closed", params: { terminalId: "terminal-1", exitCode: 0 } }, at)
    expect(withNotification(closed, { method: "terminal.output", params: { terminalId: "terminal-1", data: "late\n" } }, at)).toBe(closed)
  })
})

describe("listedWatches", () => {
  it("reads each listed terminal, keeps what is already watched, and drops what the daemon no longer lists", () => {
    const kept: TerminalWatch = { state: "watching", record: watchFrom(watched()) }
    const previous = new Map<string, TerminalWatch>([
      ["terminal-1", kept],
      ["terminal-gone", { state: "reading", summary: summary({ terminalId: "terminal-gone" }) }],
    ])
    const next = listedWatches(previous, [summary(), summary({ terminalId: "terminal-2" })])
    expect([...next.keys()]).toEqual(["terminal-1", "terminal-2"])
    const terminal = next.get("terminal-1")
    if (terminal?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(terminal.record.text).toBe(kept.record.text)
    expect(next.get("terminal-2")).toEqual({ state: "reading", summary: summary({ terminalId: "terminal-2" }) })
  })

  // The list is the daemon's word now; what the phone held is older.
  it("takes the state and the claimant from the list, not from what was held", () => {
    const kept: TerminalWatch = { state: "watching", record: watchFrom(watched()) }
    const failed: TerminalWatch = { state: "failed", summary: summary({ terminalId: "terminal-2" }), message: "no answer" }
    const closed = summary({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 1 })
    const moved = summary({ terminalId: "terminal-2", owner: { client: "web", clientId: "web-1" } })
    const next = listedWatches(new Map<string, TerminalWatch>([["terminal-1", kept], ["terminal-2", failed]]), [closed, moved])
    const first = next.get("terminal-1")
    if (first?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(terminalStatus(first.record.summary, true)).toEqual({ label: "Failed", tone: "failed" })
    // A failed watch stays failed until it is asked again; only its summary is new.
    expect(next.get("terminal-2")).toEqual({ state: "failed", summary: moved, message: "no answer" })
  })

  // Listing again on the same connection leaves a watched record current:
  // its output is still arriving.
  // Restart on a desktop reuses the terminal's id for a new shell. Its output
  // is not the old shell's, so it is read from the start.
  it("reads a terminal again when the same id names a new shell", () => {
    const kept: TerminalWatch = { state: "watching", record: watchFrom(watched()) }
    const restarted = summary({ openedAt: "2026-10-06T14:20:00.000Z" })
    expect(listedWatches(new Map([["terminal-1", kept]]), [restarted]).get("terminal-1")).toEqual({ state: "reading", summary: restarted })
  })

  it("leaves a watched record confirmed on a list from the same connection", () => {
    const kept: TerminalWatch = { state: "watching", record: watchFrom(watched()) }
    const next = listedWatches(new Map([["terminal-1", kept]]), [summary()]).get("terminal-1")
    if (next?.state !== "watching") throw new Error("a watched terminal stays watched across a list")
    expect(next.record.confirmed).toBe(true)
  })
})

// The records are the open session's. Between opening another session and
// the old records being dropped, none of them may be drawn as the new one's.
describe("watchesFor", () => {
  it("gives only the terminals of the session asked for", () => {
    const mine: TerminalWatch = { state: "watching", record: watchFrom(watched()) }
    const other: TerminalWatch = { state: "reading", summary: summary({ terminalId: "terminal-2", sessionId: "session-audit" }) }
    const held = new Map<string, TerminalWatch>([["terminal-1", mine], ["terminal-2", other]])
    expect(watchesFor(held, "session-billing")).toEqual([mine])
    expect(watchesFor(held, "session-audit")).toEqual([other])
    expect(watchesFor(held, undefined)).toEqual([])
  })
})

describe("unconfirmedWatches", () => {
  it("marks every held record as the old connection's, and leaves the rest", () => {
    const reading: TerminalWatch = { state: "reading", summary: summary({ terminalId: "terminal-2" }) }
    const next = unconfirmedWatches(new Map<string, TerminalWatch>([["terminal-1", { state: "watching", record: watchFrom(watched()) }], ["terminal-2", reading]]))
    const first = next.get("terminal-1")
    if (first?.state !== "watching") throw new Error("a watched terminal stays watched")
    expect(first.record.confirmed).toBe(false)
    expect(next.get("terminal-2")).toBe(reading)
  })
})

describe("follow", () => {
  it("starts following at the end and counts nothing while it follows", () => {
    expect(followStart).toEqual({ following: true, atEnd: true, unseen: 0 })
    expect(followAfterOutput(followStart, 4)).toBe(followStart)
    expect(showJump(followStart, false)).toBe(false)
  })

  it("counts what lands while follow is off, and offers the jump", () => {
    const off = followToggle(followStart)
    expect(off.following).toBe(false)
    const landed = followAfterOutput(followAfterOutput(off, 3), 15)
    expect(landed.unseen).toBe(18)
    expect(showJump(landed, false)).toBe(true)
  })

  it("counts what lands below a reader who scrolled up, even while following", () => {
    const reading = followAfterScroll(followStart, false)
    expect(followAfterOutput(reading, 2).unseen).toBe(2)
    expect(showJump(reading, false)).toBe(true)
  })

  it("jumps to the latest: following again, at the end, nothing unseen", () => {
    const landed = followAfterOutput(followToggle(followStart), 6)
    expect(followJump(landed)).toEqual({ following: true, atEnd: true, unseen: 0 })
    expect(followToggle(landed)).toEqual({ following: true, atEnd: true, unseen: 0 })
  })

  it("clears the count when the reader scrolls back to the end, and does not turn follow back on", () => {
    const landed = followAfterOutput(followAfterScroll(followToggle(followStart), false), 6)
    expect(followAfterScroll(landed, true)).toEqual({ following: false, atEnd: true, unseen: 0 })
  })

  // 04b: a closed terminal sends nothing more, so there is nothing to follow
  // once the reader is at its end.
  it("offers no jump on a closed terminal read to its end", () => {
    expect(showJump(followToggle(followStart), true)).toBe(false)
  })

  // Its last lines can land below a reader just before it closes; the way
  // down to them stays until the reader is there.
  it("keeps the jump on a closed terminal while lines are below the reader", () => {
    expect(showJump(followAfterOutput(followToggle(followStart), 3), true)).toBe(true)
    expect(showJump(followAfterScroll(followStart, false), true)).toBe(true)
    expect(showJump(followJump(followAfterOutput(followToggle(followStart), 3)), true)).toBe(false)
    // A last piece with no line break counts no line but may still be below.
    expect(showJump(followToggle(followStart), true, true)).toBe(true)
  })
})

// #779: a watch that asked with followResize hears terminal.resized when the
// holder changes the grid. The phone draws lines rather than a grid, so only
// the size it names follows.
describe("withNotification and terminal.resized", () => {
  const resized = { method: "terminal.resized" as const, params: { terminalId: "terminal-1", cols: 80, rows: 24 } }

  it("names the holder's new grid and counts the notice as heard", () => {
    const record = withNotification(watchFrom(watched()), resized, at)
    expect(terminalSize(record.summary)).toBe("80×24")
    expect(record.lastHeardAt).toBe(at.toISOString())
    // The text is the same text; nothing is redrawn at a width.
    expect(record.text).toBe(watchFrom(watched()).text)
  })

  it("leaves another terminal's record and a closed shell's size alone", () => {
    const record = watchFrom(watched())
    expect(withNotification(record, { ...resized, params: { ...resized.params, terminalId: "terminal-2" } }, at)).toBe(record)
    const closed = watchFrom(watched({ state: "closed", closedAt: "2026-10-06T14:09:40.000Z", exitCode: 0, claimHeld: false }))
    expect(withNotification(closed, resized, at)).toBe(closed)
  })
})

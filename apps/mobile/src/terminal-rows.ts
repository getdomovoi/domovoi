import {
  maximumTerminalReplayCharacters,
  type ClientKind,
  type TerminalSummary,
  type TerminalWatchResult,
} from "@getdomovoi/protocol"

import type { TerminalNotification } from "./lib/daemon"

// Phone v2 frame 04: a phone reads the claimant's shell and never types,
// resizes or claims it. What the phone holds for one watched terminal is the
// daemon's record at the moment of the watch (already redacted before the
// daemon kept it) and what arrived live after it.

export type TerminalRecord = {
  summary: TerminalSummary
  // The daemon's record and then live output, as one text. The record can end
  // mid-line, mid escape sequence or mid overwrite, and live output carries
  // on from exactly there, so the two are read together.
  text: string
  // Where live output begins in text. Undefined for a terminal that was
  // closed when it was watched, and once the phone has cut past that point.
  liveAt: number | undefined
  // When live output began, by the daemon's clock.
  liveFrom: string | undefined
  replayStartsAt: string | undefined
  // The daemon's record does not start at the shell's start.
  machineDropped: boolean
  // The phone cut the front of what it holds, to keep no more than the
  // daemon keeps. Once cut, the machine's start time no longer describes it.
  phoneDropped: boolean
  // Text may begin inside an escape sequence or a window title: the daemon
  // keeps its record by size and cuts it anywhere. The rest of that first
  // line is not drawn when a line break follows soon after. The phone's own
  // cut never lands inside a sequence (sequenceSafe), so once it has cut, the
  // text is drawn from its start.
  startsMidLine: boolean
  // Line breaks received live, counted as they arrive and never reduced by a
  // cut, so what landed can be counted for the reader.
  received: number
  // The last time anything was heard for this terminal: the watch, then each
  // piece of output. The gap a dropped connection leaves starts here.
  lastHeardAt: string
  // False for a record kept across a reconnect: the daemon's list has spoken
  // since, but the output is the old connection's until the new watch answers.
  confirmed: boolean
}

// A terminal the session lists, and how far reading it has got.
export type TerminalWatch =
  | { state: "reading", summary: TerminalSummary }
  | { state: "failed", summary: TerminalSummary, message: string }
  | { state: "watching", record: TerminalRecord }

export type TerminalRow = { kind: "line" | "mark", key: string, text: string }

export type TerminalTone = "live" | "failed" | "closed" | "unconfirmed"

export function watchFrom(result: TerminalWatchResult): TerminalRecord {
  const { buffer, bufferStartsAt, earlierOutputDropped, watchedAt, ...summary } = result
  const live = summary.state === "live"
  return {
    summary,
    text: buffer,
    liveAt: live ? buffer.length : undefined,
    liveFrom: live ? watchedAt : undefined,
    replayStartsAt: bufferStartsAt,
    machineDropped: earlierOutputDropped,
    phoneDropped: false,
    startsMidLine: earlierOutputDropped,
    received: 0,
    lastHeardAt: watchedAt,
    confirmed: true,
  }
}

export function watchedSummary(watch: TerminalWatch): TerminalSummary {
  return watch.state === "watching" ? watch.record.summary : watch.summary
}

// The terminals of one session. What the phone holds is dropped after another
// session opens, not before its first frame, so a screen draws only these.
export function watchesFor(held: ReadonlyMap<string, TerminalWatch>, sessionId: string | undefined): TerminalWatch[] {
  if (!sessionId) return []
  return [...held.values()].filter((watch) => watchedSummary(watch).sessionId === sessionId)
}

// The daemon's answer to terminal.list, laid over what the phone already
// reads. The list is the daemon's word now, so every summary comes from it. A
// terminal still listed keeps its output and how far reading it got; one no
// longer listed is gone; a new one starts reading.
export function listedWatches(
  previous: ReadonlyMap<string, TerminalWatch>,
  listed: readonly TerminalSummary[],
): Map<string, TerminalWatch> {
  return new Map(listed.map((terminal): [string, TerminalWatch] => {
    const held = previous.get(terminal.terminalId)
    // Restart on a desktop reuses the id for a new shell, opened later. What
    // was held is the old shell's, so the new one is read from its start.
    const sameShell = held !== undefined && watchedSummary(held).openedAt === terminal.openedAt
    if (held?.state === "watching" && sameShell) return [terminal.terminalId, { state: "watching", record: { ...held.record, summary: terminal } }]
    if (held?.state === "failed" && sameShell) return [terminal.terminalId, { ...held, summary: terminal }]
    return [terminal.terminalId, { state: "reading", summary: terminal }]
  }))
}

// How often the open session's terminals are listed again. Nothing tells a
// client that a terminal opened, so a new one is found by asking.
export const terminalListIntervalMs = 10_000

// A new connection holds no watch: what was read on the old one stays on
// screen, marked as the old connection's, until it is watched again.
export function unconfirmedWatches(previous: ReadonlyMap<string, TerminalWatch>): ReadonlyMap<string, TerminalWatch> {
  if (![...previous.values()].some((watch) => watch.state === "watching" && watch.record.confirmed)) return previous
  return new Map([...previous].map(([terminalId, watch]): [string, TerminalWatch] => [
    terminalId,
    watch.state === "watching" ? { state: "watching", record: { ...watch.record, confirmed: false } } : watch,
  ]))
}

// A notification for this record's terminal. Anything for another terminal,
// or output after the shell closed, leaves the record as it was.
export function withNotification(record: TerminalRecord, notification: TerminalNotification, now: Date): TerminalRecord {
  if (notification.params.terminalId !== record.summary.terminalId) return record
  if (notification.method === "terminal.ownership") {
    if (record.summary.state === "closed") return record
    return { ...record, summary: { ...record.summary, owner: notification.params.owner, claimHeld: true } }
  }
  if (record.summary.state === "closed") return record
  if (notification.method === "terminal.closed") {
    const { exitCode, signal } = notification.params
    // The notification carries no time, and the phone's clock is not the
    // daemon's, so the close time is left for the daemon's list to give.
    const { exitCode: _exitCode, signal: _signal, closedAt: _closedAt, ...rest } = record.summary
    return {
      ...record,
      summary: {
        ...rest,
        state: "closed",
        claimHeld: false,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
      },
    }
  }
  const { data } = notification.params
  return bounded({
    ...record,
    text: record.text + data,
    received: record.received + data.split("\n").length - 1,
    lastHeardAt: now.toISOString(),
  })
}

// How far past the bound a cut may reach for a line break, so the first line
// shown is whole. Output with no break that near is cut at the bound itself.
const lineBreakReach = 256

// The phone holds no more than the daemon keeps for a terminal. The oldest
// text goes first.
function bounded(record: TerminalRecord): TerminalRecord {
  const excess = record.text.length - maximumTerminalReplayCharacters
  if (excess <= 0) return record
  const lineBreak = record.text.indexOf("\n", excess - 1)
  const atLineBreak = lineBreak !== -1 && lineBreak + 1 - excess <= lineBreakReach
  let cut = atLineBreak ? lineBreak + 1 : sequenceSafe(record.text, excess)
  // A cut between the two halves of a character outside the basic plane
  // takes the whole character.
  if (isLowSurrogate(record.text.charCodeAt(cut))) cut += 1
  return {
    ...record,
    text: record.text.slice(cut),
    // Once the start of live output is cut away, nothing above it is left.
    liveAt: record.liveAt !== undefined && record.liveAt > cut ? record.liveAt - cut : undefined,
    phoneDropped: true,
    startsMidLine: false,
  }
}

// Escape sequences that draw nothing, each anchored at its introducer. The
// two-character form leaves out "[" and "]", which open the longer ones.
// eslint-disable-next-line no-control-regex -- the sequences are made of control characters
const sequenceAtStart = /^(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\^_])/
// A sequence still arriving: an introducer whose end has not come yet, so it
// runs to the end of the text. A title can end in ESC with its backslash
// still to come.
// eslint-disable-next-line no-control-regex -- the sequences are made of control characters
const sequenceUnfinished = /^\u001b(?:\][^\u0007\u001b]*\u001b?|\[[0-?]*[ -/]*)?$/
// The longest unfinished sequence kept whole across a cut, so the phone holds
// at most this much past its bound. Longer, and the bound wins.
const unfinishedSequenceReach = 4_096

// A cut that would fall inside an escape sequence, however long, moves to
// just after it, so what is kept never begins with a sequence's parameters,
// such as "[31m", or a window title's text. One still arriving is kept whole
// from its introducer, so it is read once its end comes.
function sequenceSafe(text: string, cut: number): number {
  const escape = text.lastIndexOf("\u001b", cut - 1)
  if (escape === -1) return cut
  const rest = text.slice(escape)
  const sequence = sequenceAtStart.exec(rest)
  if (sequence) return Math.max(cut, escape + sequence[0].length)
  return sequenceUnfinished.test(rest) && cut - escape <= unfinishedSequenceReach ? escape : cut
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

// Where the drawn text starts when it began partway through a line: past the
// rest of a window title it began inside, then past the rest of that line
// when a line break is near. Without one the line is drawn as it stands
// rather than dropping a long run of output.
function drawnStart(record: TerminalRecord): number {
  if (!record.startsMidLine) return 0
  let start = 0
  // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
  const titleEnd = /\u0007|\u001b\\/.exec(record.text.slice(0, unfinishedSequenceReach))
  // A title's end with no introducer and no line break before it closes a
  // title that began before the text did.
  // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
  if (titleEnd && !/[\u001b\n]/.test(record.text.slice(0, titleEnd.index))) start = titleEnd.index + titleEnd[0].length
  const lineBreak = record.text.indexOf("\n", start)
  return lineBreak !== -1 && lineBreak - start < lineBreakReach ? lineBreak + 1 : start
}

// What a terminal draws, read as lines. Colour and cursor-movement sequences
// are dropped; a carriage return overwrites the line from its start as a
// progress bar does; a backspace and an erase-in-line erase. The line still
// being written is kept; the empty line after a final newline is not.
export function terminalLines(text: string): string[] {
  const lines = plainText(text).split("\n").map(drawnLine)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

// Erase-in-line survives the stripping as one control character each, which
// drawnLine acts on. The characters are cleared from the text first; they
// draw nothing on a terminal either.
const eraseToEnd = "\u0001"
const eraseToStart = "\u0002"
const eraseLine = "\u0003"

// The text with escape sequences dropped and line breaks made plain.
function plainText(text: string): string {
  return text
    // Operating system commands, such as a window title.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/[\u0001-\u0003]/g, "")
    // Erase in line: to its end, to its start, all of it.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b\[([012]?)K/g, (_sequence, mode: string) => mode === "1" ? eraseToStart : mode === "2" ? eraseLine : eraseToEnd)
    // Other control sequences: colour, cursor movement.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // Any other two-character escape.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
}

// One cell per character, so a character outside the basic plane, two UTF-16
// units, is overwritten and erased as one.
function drawnLine(raw: string): string {
  let cells: string[] = []
  let column = 0
  let erased = false
  for (const char of raw) {
    if (char === "\r") column = 0
    else if (char === "\b") column = Math.max(0, column - 1)
    else if (char === eraseToEnd) cells = cells.slice(0, column)
    else if (char === eraseToStart || char === eraseLine) {
      const through = char === eraseLine ? cells.length : Math.min(cells.length, column + 1)
      cells = cells.map((cell, at) => at < through ? " " : cell)
      erased = true
    } else if (char === "\t" || (char >= " " && char !== "\u007f")) {
      // A cursor past the end, after an erase to the end, leaves blanks.
      while (cells.length < column) cells.push(" ")
      cells[column] = char
      column += 1
    }
  }
  // A backspace moves the cursor without erasing; what stays visible past the
  // cursor at the end of a line is what the person typed over, so a line
  // ended by backspaces ends at the cursor.
  const drawn = (raw.endsWith("\b") ? cells.slice(0, column) : cells).join("")
  // Blanks an erase left at the end of a line are not text.
  return erased ? drawn.replace(/ +$/, "") : drawn
}

export function terminalLineCount(record: TerminalRecord): number {
  return terminalLines(record.text.slice(drawnStart(record))).length
}

// The record, then live output, with the marks the design draws between them.
// The live mark goes under the record's last whole line; a line the record
// left unfinished is finished live, so it reads under the mark.
export function terminalRows(record: TerminalRecord, connected: boolean): TerminalRow[] {
  const rows: TerminalRow[] = []
  if (record.phoneDropped) {
    rows.push({ kind: "mark", key: "phone-dropped", text: "Earlier output was not kept on this phone." })
  } else if (record.machineDropped && record.replayStartsAt) {
    rows.push({ kind: "mark", key: "machine-dropped", text: `Earlier output was not kept. The machine's record of this terminal starts at ${clock(record.replayStartsAt)}.` })
  }
  const start = drawnStart(record)
  const text = record.text.slice(start)
  const lines = terminalLines(text)
  // Live output that began inside the line not drawn has nothing above it.
  const liveAt = record.liveAt !== undefined ? record.liveAt - start : undefined
  const markAt = record.liveFrom && liveAt !== undefined && liveAt > 0 ? wholeLines(text.slice(0, liveAt)) : undefined
  const liveMark: TerminalRow | undefined = record.liveFrom
    ? { kind: "mark", key: "live-from", text: `Recent output above. Live from ${clock(record.liveFrom)}.` }
    : undefined
  lines.forEach((text, index) => {
    if (index === markAt && liveMark) rows.push(liveMark)
    rows.push({ kind: "line", key: `line-${index}`, text })
  })
  if (markAt !== undefined && markAt >= lines.length && liveMark) rows.push(liveMark)
  const { summary } = record
  // The gap: output held from an older connection, or a live shell whose
  // connection is down. A shell whose end arrived on this record has none.
  if (!record.confirmed || (!connected && summary.state === "live")) {
    rows.push({ kind: "mark", key: "dropped", text: `Nothing received since ${clock(record.lastHeardAt)}. Reconnecting replays the recent output first.` })
  }
  if (summary.state === "closed") {
    const at = summary.closedAt ? ` at ${clock(summary.closedAt)}` : ""
    const signal = endingSignal(summary)
    rows.push({
      kind: "mark",
      key: "closed",
      text: signal !== undefined
        ? `The shell ended on signal ${signal}${at}. No more output will arrive.`
        : summary.exitCode !== undefined
          ? `The shell exited with code ${summary.exitCode}${at}. No more output will arrive.`
          : `The shell closed${at}. No more output will arrive.`,
    })
  }
  return rows
}

// The signal that ended a shell. The daemon sends the exit code with it, and
// a signal of 0 for a shell that exited on its own, which is no signal.
function endingSignal(summary: TerminalSummary): number | undefined {
  return summary.signal !== undefined && summary.signal !== 0 ? summary.signal : undefined
}

// The lines of a text that are finished: all of them when what it draws ends
// on a line break, all but the last otherwise.
function wholeLines(text: string): number {
  const count = terminalLines(text).length
  return plainText(text).endsWith("\n") ? count : Math.max(0, count - 1)
}

// Failed is a shell that exited with a code other than zero. A shell ended by
// a signal is how a desktop closing it looks, so that is Closed. While the
// connection is down nothing is confirmed either way.
export function terminalStatus(summary: TerminalSummary, connected: boolean): { label: string, tone: TerminalTone } {
  if (!connected) return { label: "Unconfirmed", tone: "unconfirmed" }
  if (summary.state === "live") return { label: "Live", tone: "live" }
  if (endingSignal(summary) === undefined && summary.exitCode !== undefined && summary.exitCode !== 0) return { label: "Failed", tone: "failed" }
  return { label: "Closed", tone: "closed" }
}

// The claimant is named by the device label it claimed with. A root bearer
// has no paired device, so its client kind is what is known about it.
export function claimantLine(summary: TerminalSummary, connected: boolean): string {
  const name = summary.owner.device?.label ?? `a ${clientNames[summary.owner.client]} client`
  if (!connected) return `Last heard: claimed by ${name}`
  if (summary.state === "closed" || !summary.claimHeld) return `Last claimed by ${name}`
  return `Claimed by ${name}`
}

const clientNames: Record<ClientKind, string> = {
  desktop: "desktop",
  web: "web",
  tablet: "tablet",
  phone: "phone",
  cli: "command line",
}

// "zsh · wt-billing-idem": the shell and the directory it runs in, by name.
export function terminalTitle(summary: TerminalSummary): string {
  return `${lastSegment(summary.shell)} · ${lastSegment(summary.cwd)}`
}

// The claimant's size. A phone never resizes it, so long lines wrap here.
export function terminalSize(summary: TerminalSummary): string {
  return `${summary.cols}×${summary.rows}`
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

// "14:06:12" in local time.
function clock(value: string): string {
  const time = new Date(value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

// Following output, as the design's toggle and jump describe it. Following
// keeps the view at the end while it is there; a reader who scrolls up is
// left alone, and what lands below them is counted. Only the toggle or the
// jump turns following back on, so scrolling to the end by hand does not.
export type Follow = { following: boolean, atEnd: boolean, unseen: number }

export const followStart: Follow = { following: true, atEnd: true, unseen: 0 }

export function followAfterOutput(follow: Follow, added: number): Follow {
  if (added <= 0 || (follow.following && follow.atEnd)) return follow
  return { ...follow, unseen: follow.unseen + added }
}

export function followAfterScroll(follow: Follow, atEnd: boolean): Follow {
  return atEnd ? { ...follow, atEnd, unseen: 0 } : { ...follow, atEnd }
}

export function followJump(_follow: Follow): Follow {
  return { following: true, atEnd: true, unseen: 0 }
}

export function followToggle(follow: Follow): Follow {
  return follow.following ? { ...follow, following: false } : followJump(follow)
}

// A closed terminal sends nothing more, so it offers no jump.
export function showJump(follow: Follow, closed: boolean): boolean {
  return !closed && (!follow.following || !follow.atEnd)
}

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

// One piece of live output, as the daemon sent it.
type Chunk = { text: string }

export type TerminalRecord = {
  summary: TerminalSummary
  replay: string
  replayStartsAt: string | undefined
  // The daemon's record does not start at the shell's start.
  machineDropped: boolean
  // The phone cut the front of what it holds, to keep no more than the
  // daemon keeps. Once cut, the machine's start time no longer describes it.
  phoneDropped: boolean
  // When live output began. Undefined for a terminal that was already closed
  // when it was watched: nothing live followed its record.
  liveFrom: string | undefined
  live: Chunk[]
  // The last time anything was heard for this terminal: the watch, then each
  // piece of output. The gap a dropped connection leaves starts here.
  lastHeardAt: string
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
  return {
    summary,
    replay: buffer,
    replayStartsAt: bufferStartsAt,
    machineDropped: earlierOutputDropped,
    phoneDropped: false,
    liveFrom: summary.state === "live" ? watchedAt : undefined,
    live: [],
    lastHeardAt: watchedAt,
  }
}

export function watchedSummary(watch: TerminalWatch): TerminalSummary {
  return watch.state === "watching" ? watch.record.summary : watch.summary
}

// The daemon's answer to terminal.list, laid over what the phone already
// reads: a terminal still listed keeps its record until a new watch replaces
// it, one no longer listed is gone, and a new one starts reading.
export function listedWatches(
  previous: ReadonlyMap<string, TerminalWatch>,
  listed: readonly TerminalSummary[],
): Map<string, TerminalWatch> {
  return new Map(listed.map((terminal) => [
    terminal.terminalId,
    previous.get(terminal.terminalId) ?? { state: "reading", summary: terminal },
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
    const { exitCode: _exitCode, signal: _signal, ...rest } = record.summary
    return {
      ...record,
      summary: {
        ...rest,
        state: "closed",
        claimHeld: false,
        closedAt: now.toISOString(),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
      },
    }
  }
  return bounded({
    ...record,
    live: [...record.live, { text: notification.params.data }],
    lastHeardAt: now.toISOString(),
  })
}

// The phone holds no more than the daemon keeps for a terminal. The oldest
// text goes first, from the record and then from live output, cut at a line
// break where one is near so the first line shown is whole.
function bounded(record: TerminalRecord): TerminalRecord {
  let excess = record.replay.length + record.live.reduce((total, chunk) => total + chunk.text.length, 0) - maximumTerminalReplayCharacters
  if (excess <= 0) return record
  let replay = record.replay
  const live = [...record.live]
  if (replay.length > 0) {
    const cut = Math.min(replay.length, excess)
    replay = replay.slice(lineBreakAfter(replay, cut))
    excess -= record.replay.length - replay.length
  }
  while (excess > 0 && live.length > 0) {
    const first = live[0]!
    if (first.text.length <= excess) {
      live.shift()
      excess -= first.text.length
      continue
    }
    const text = first.text.slice(lineBreakAfter(first.text, excess))
    excess -= first.text.length - text.length
    if (text) live[0] = { text }
    else live.shift()
  }
  return { ...record, replay, live, phoneDropped: true }
}

// The index just past the first line break at or after `from`, or the end.
function lineBreakAfter(text: string, from: number): number {
  const at = text.indexOf("\n", Math.max(0, from - 1))
  return at === -1 ? text.length : at + 1
}

// What a terminal draws, read as lines. Colour and cursor sequences are
// dropped, a carriage return overwrites the line from its start as a progress
// bar does, and a backspace erases. The line still being written is kept; the
// empty line after a final newline is not.
export function terminalLines(text: string): string[] {
  const plain = text
    // Operating system commands, such as a window title.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // Control sequences: colour, cursor movement, erase.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // Any other two-character escape.
    // eslint-disable-next-line no-control-regex -- the sequences are made of control characters
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
  const lines = plain.split("\n").map(drawnLine)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function drawnLine(raw: string): string {
  let line = ""
  let column = 0
  for (const char of raw) {
    if (char === "\r") column = 0
    else if (char === "\b") column = Math.max(0, column - 1)
    else if (char === "\t" || char >= " ") {
      line = line.slice(0, column) + char + line.slice(column + 1)
      column += 1
    }
  }
  // A backspace moves the cursor without erasing; what stays visible past the
  // cursor at the end of a line is what the person typed over, so a line
  // ended by backspaces ends at the cursor.
  return raw.endsWith("\b") ? line.slice(0, column) : line
}

export function terminalLineCount(record: TerminalRecord): number {
  return terminalLines(record.replay).length + terminalLines(liveText(record)).length
}

function liveText(record: TerminalRecord): string {
  return record.live.map((chunk) => chunk.text).join("")
}

// The record, then live output, with the marks the design draws between them.
export function terminalRows(record: TerminalRecord, connected: boolean): TerminalRow[] {
  const rows: TerminalRow[] = []
  if (record.phoneDropped) {
    rows.push({ kind: "mark", key: "phone-dropped", text: "Earlier output was not kept on this phone." })
  } else if (record.machineDropped && record.replayStartsAt) {
    rows.push({ kind: "mark", key: "machine-dropped", text: `Earlier output was not kept. The machine's record of this terminal starts at ${clock(record.replayStartsAt)}.` })
  }
  terminalLines(record.replay).forEach((text, index) => rows.push({ kind: "line", key: `replay-${index}`, text }))
  if (record.liveFrom && record.replay.length > 0) {
    rows.push({ kind: "mark", key: "live-from", text: `Recent output above. Live from ${clock(record.liveFrom)}.` })
  }
  terminalLines(liveText(record)).forEach((text, index) => rows.push({ kind: "line", key: `live-${index}`, text }))
  const { summary } = record
  if (summary.state === "closed") {
    const when = summary.closedAt ? clock(summary.closedAt) : "an unknown time"
    rows.push({
      kind: "mark",
      key: "closed",
      text: summary.exitCode !== undefined
        ? `The shell exited with code ${summary.exitCode} at ${when}. No more output will arrive.`
        : summary.signal !== undefined
          ? `The shell ended on signal ${summary.signal} at ${when}. No more output will arrive.`
          : `The shell closed at ${when}. No more output will arrive.`,
    })
  } else if (!connected) {
    rows.push({ kind: "mark", key: "dropped", text: `Nothing received since ${clock(record.lastHeardAt)}. Reconnecting replays the recent output first.` })
  }
  return rows
}

// Failed is a shell that exited with a code other than zero. A shell ended by
// a signal is how a desktop closing it looks, so that is Closed. While the
// connection is down nothing is confirmed either way.
export function terminalStatus(summary: TerminalSummary, connected: boolean): { label: string, tone: TerminalTone } {
  if (!connected) return { label: "Unconfirmed", tone: "unconfirmed" }
  if (summary.state === "live") return { label: "Live", tone: "live" }
  if (summary.exitCode !== undefined && summary.exitCode !== 0) return { label: "Failed", tone: "failed" }
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

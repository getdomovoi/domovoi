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

  it("erases a character for a backspace", () => {
    // A shell echoes an erase as back, space, back.
    expect(terminalLines("lss\b \b\n")).toEqual(["ls"])
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
})

describe("withNotification", () => {
  it("moves the claimant line when the claim moves", () => {
    const record = withNotification(
      watchFrom(watched({ claimHeld: false })),
      { method: "terminal.ownership", params: { terminalId: "terminal-1", owner: { client: "web", clientId: "web-1", device: { id: `device-${"b".repeat(32)}`, label: "Studio" } } } },
      at,
    )
    expect(claimantLine(record.summary, true)).toBe("Claimed by Studio")
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

  // 04b: a closed terminal sends nothing more, so there is nothing to follow.
  it("offers no jump on a closed terminal", () => {
    expect(showJump(followToggle(followStart), true)).toBe(false)
  })
})

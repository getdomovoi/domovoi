import { describe, expect, it } from "vitest"

import { devLoopKindVariable, devLoopStateVariable, lockHeldLine, mainBootLine, nextBootCount, reportLockHeld, reportMainBoot } from "./dev-loop-log.js"

function harness(seed?: string) {
  const lines: string[] = []
  let stored = seed
  return {
    lines,
    stored: () => stored,
    run: (environment: NodeJS.ProcessEnv) => reportMainBoot({
      environment,
      readState: () => stored,
      writeState: (_path, value) => { stored = value },
      log: (line) => lines.push(line),
    }),
  }
}

describe("the development loop boot report", () => {
  it("says nothing when the loop is not running", () => {
    const state = harness()
    state.run({})
    expect(state.lines).toEqual([])
  })

  it("names the first boot as a start, not a relaunch", () => {
    const state = harness()
    state.run({ [devLoopStateVariable]: "/tmp/loop-state" })
    expect(state.lines[0]).toContain("window started")
    expect(state.lines[0]).not.toContain("relaunched")
    expect(state.stored()).toBe("1")
  })

  it("names every later boot a relaunch and keeps counting", () => {
    const state = harness()
    const environment = { [devLoopStateVariable]: "/tmp/loop-state" }
    state.run(environment)
    state.run(environment)
    state.run(environment)
    expect(state.lines[1]).toContain("window relaunched (main or preload edit, boot 2)")
    expect(state.lines[2]).toContain("boot 3")
    expect(state.stored()).toBe("3")
  })

  it("treats unreadable state as a first boot rather than guessing", () => {
    expect(nextBootCount(undefined)).toBe(1)
    expect(nextBootCount("")).toBe(1)
    expect(nextBootCount("not a number")).toBe(1)
    expect(nextBootCount("0")).toBe(1)
    expect(nextBootCount("-4")).toBe(1)
    expect(nextBootCount("7")).toBe(8)
  })

  // A window that loses the single-instance lock quits with exit code zero and
  // prints nothing, which reads as a clean shutdown. It cost two runs here.
  it("says the lock is held instead of quitting silently", () => {
    const lines: string[] = []
    reportLockHeld({ environment: { [devLoopStateVariable]: "/tmp/loop-state" }, log: (line) => lines.push(line) })
    expect(lines).toEqual([lockHeldLine()])
    expect(lines[0]).toContain("single-instance lock")
    expect(lines[0]).toContain("Close the other window")
  })

  it("says nothing about the lock outside the loop", () => {
    const lines: string[] = []
    reportLockHeld({ environment: {}, log: (line) => lines.push(line) })
    expect(lines).toEqual([])
  })

  it("never reports a boot and a held lock as the same event", () => {
    expect(lockHeldLine()).not.toContain("relaunched")
    expect(lockHeldLine()).not.toContain("window started")
  })

  it("tells the reader which edits do which on the line they see first", () => {
    expect(mainBootLine(1)).toContain("Renderer edits apply in place")
    expect(mainBootLine(1)).toContain("main and preload edits relaunch")
    expect(mainBootLine(2)).toContain("Fixture state kept")
  })

  it("names the real daemon without claiming fixture state", () => {
    const state = harness()
    state.run({ [devLoopStateVariable]: "/tmp/loop-state", [devLoopKindVariable]: "daemon" })
    expect(state.lines[0]).toContain("real daemon")
    expect(state.lines[0]).not.toContain("fixture")
    expect(mainBootLine(2, "daemon")).toContain("Daemon state kept")
  })
})

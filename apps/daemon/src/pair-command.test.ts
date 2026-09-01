import { describe, expect, it, vi } from "vitest"

import { runPairCommand } from "./pair-command.js"

function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  }
}

const issued = { code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z" }

describe("runPairCommand", () => {
  it("prints the code a person reads to the other machine", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)

    const status = await runPairCommand(["pair"], { issue, ...io })

    expect(status).toBe(0)
    expect(io.out.join("")).toContain(issued.code)
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it("says how long the code lasts, so nobody reads out a dead one", async () => {
    const io = recorder()

    await runPairCommand(["pair"], { issue: async () => issued, ...io })

    expect(io.out.join("")).toContain("3 minutes")
  })

  it("says what to do with the code", async () => {
    const io = recorder()

    await runPairCommand(["pair"], { issue: async () => issued, ...io })

    expect(io.out.join("")).toMatch(/enter it on the machine/i)
  })

  it("reports a daemon it could not reach without printing a code", async () => {
    const io = recorder()
    const issue = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })

    const status = await runPairCommand(["pair"], { issue, ...io })

    expect(status).toBe(1)
    expect(io.err.join("")).toContain("Could not ask the daemon for a pairing code")
    expect(io.out.join("")).toBe("")
  })

  it("refuses arguments it does not understand", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)

    const status = await runPairCommand(["pair", "--forever"], { issue, ...io })

    expect(status).toBe(1)
    expect(issue).not.toHaveBeenCalled()
    expect(io.err.join("")).toContain("Usage: domovoid pair")
  })

  it("ignores a command that is not pair", async () => {
    const io = recorder()

    expect(await runPairCommand(["secret", "status"], { issue: async () => issued, ...io }))
      .toBe(1)
    expect(io.out.join("")).toBe("")
  })
})

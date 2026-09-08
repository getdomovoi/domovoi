import { describe, expect, it, vi } from "vitest"

import { CliDeadlineError } from "./cli-rpc.js"
import { runPairCommand } from "./pair-command.js"

function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    grantClient: vi.fn(),
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  }
}

const issued = { code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z" }

describe("runPairCommand", () => {
  it("grants an explicitly requested client kind without issuing a machine pairing code", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)
    const grantClient = vi.fn(async () => ({ token: "n".repeat(43), device: {
      id: `device-${"a".repeat(32)}`, label: "Laptop desktop", pairedAt: "2026-09-06T12:00:00Z",
      binding: { kind: "client" as const, client: "desktop" as const },
    } }))
    expect(await runPairCommand(["pair", "--client", "desktop", "--label", "Laptop desktop"], { ...io, issue, grantClient })).toBe(0)
    expect(issue).not.toHaveBeenCalled()
    expect(grantClient).toHaveBeenCalledWith({ targetClient: "desktop", label: "Laptop desktop" })
    expect(io.out.join("")).toContain("n".repeat(43))
    expect(io.out.join("")).toContain("session sends, approvals and terminals")
    expect(io.out.join("")).toContain("Revoke")
  })

  it("rejects invalid client grants before contacting the daemon", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)
    expect(await runPairCommand(["pair", "--client", "machine", "--label", "wrong role"], { ...io, issue })).toBe(1)
    expect(io.grantClient).not.toHaveBeenCalled()
    expect(issue).not.toHaveBeenCalled()
  })

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

  it("repeats a deadline refusal that names the address and the remedy", async () => {
    const io = recorder()
    const issue = vi.fn(async () => {
      throw new CliDeadlineError("The daemon at ws://127.0.0.1:47831/rpc did not answer device.issueCode"
        + " before the deadline. Check that domovoid is running at that address, then run this command again.")
    })

    const status = await runPairCommand(["pair"], { issue, ...io })

    expect(status).toBe(1)
    expect(io.err.join("")).toContain("ws://127.0.0.1:47831/rpc did not answer device.issueCode before the deadline")
    expect(io.err.join("")).toContain("Check that domovoid is running at that address")
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

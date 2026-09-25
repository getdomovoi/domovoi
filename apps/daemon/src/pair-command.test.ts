import { decodePairingPayload, phoneAndTabletPromise } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import { CliDeadlineError } from "./cli-rpc.js"
import { runPairCommand } from "./pair-command.js"

function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    renderCode: (payload: string) => `<qr>${payload}</qr>\n`,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  }
}

// The daemon names the address beside the code; the command draws it and
// never works one out for itself.
const issued = {
  code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z",
  pairingAddress: { url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", label: "djs-macbook-pro-1", loopback: false },
}

describe("runPairCommand", () => {
  it("shows a single-use code for the requested client, as a symbol and as text", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)
    expect(await runPairCommand(["pair", "--client", "phone", "--label", "iPhone"], { ...io, issue })).toBe(0)
    expect(issue).toHaveBeenCalledWith("phone")
    const out = io.out.join("")
    // The symbol carries a code and an address, never a credential.
    const drawn = /<qr>(.*)<\/qr>/.exec(out)
    expect(drawn).not.toBeNull()
    expect(decodePairingPayload(drawn![1]!)).toEqual({
      v: 1, url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", code: issued.code, label: "djs-macbook-pro-1",
    })
    // The pasteable text is the same pairing the symbol carries.
    expect(out).toContain(`Paste this on the device:\n${drawn![0]!.replace(/^<qr>|<\/qr>\n?$/g, "")}`)
    expect(out).toContain("It works once, and only for a phone.")
    expect(out).toContain("It lasts 3 minutes. Run this again for a fresh one, which stops the old code.")
    expect(out).toContain("A paired phone can:")
    for (const line of phoneAndTabletPromise) expect(out).toContain(line.text)
    // The unbuilt line is marked, not silently listed beside the kept ones.
    expect(out).toContain("! Terminal output is not on a phone yet.")
  })

  it("does not print the promise for a client that is not carried by hand", async () => {
    const io = recorder()
    expect(await runPairCommand(["pair", "--client", "desktop", "--label", "Operator desktop"], { ...io, issue: vi.fn(async () => issued) })).toBe(0)
    const out = io.out.join("")
    expect(out).not.toContain("A paired desktop can:")
    expect(out).toContain("It works once, and only for a desktop.")
  })

  it("says an older daemon does not name an address, rather than failing", async () => {
    const io = recorder()
    // A daemon from before issueCode named its address answers with the code alone.
    const older = { ...io, issue: vi.fn(async () => ({ code: issued.code, expiresAt: issued.expiresAt }) as unknown as typeof issued) }
    expect(await runPairCommand(["pair", "--client", "phone", "--label", "iPhone"], older)).toBe(1)
    expect(io.out.join("")).toContain(issued.code)
    expect(io.err.join("")).toContain("This daemon does not say which address a device should dial")
    expect(io.out.join("")).not.toContain("<qr>")
  })

  it("says the daemon answers only on this machine rather than drawing a code a phone cannot dial", async () => {
    const io = recorder()
    const loopback = { ...io, issue: vi.fn(async () => ({ ...issued, pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } })) }
    expect(await runPairCommand(["pair", "--client", "phone", "--label", "iPhone"], loopback)).toBe(0)
    expect(io.out.join("")).toContain("which only this machine can reach")
  })

  it("says why there is no code to scan rather than drawing one that fails at TLS", async () => {
    const io = recorder()
    const unreachable = {
      ...io,
      issue: vi.fn(async () => ({ ...issued, pairingAddress: { problem: "This daemon's certificate names no host a device could dial." } })),
    }
    expect(await runPairCommand(["pair", "--client", "phone", "--label", "iPhone"], unreachable)).toBe(1)
    expect(io.out.join("")).toContain(issued.code)
    expect(io.err.join("")).toContain("names no host a device could dial")
    expect(io.out.join("")).not.toContain("<qr>")
  })

  it("rejects invalid client grants before contacting the daemon", async () => {
    const io = recorder()
    const issue = vi.fn(async () => issued)
    expect(await runPairCommand(["pair", "--client", "machine", "--label", "wrong role"], { ...io, issue })).toBe(1)
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

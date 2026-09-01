import { describe, expect, it, vi } from "vitest"

import { daemonAuthenticationErrorCode } from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { MachineReconnectError, reconnectMachine } from "./machine-reconnect.js"

function waiter() {
  const waited: number[] = []
  return { waited, wait: vi.fn(async (ms: number) => { waited.push(ms) }) }
}

describe("reconnectMachine", () => {
  it("takes the first connection without waiting", async () => {
    const clock = waiter()
    const connect = vi.fn(async () => "connection")

    await expect(reconnectMachine({ connect, wait: clock.wait })).resolves.toBe("connection")
    expect(clock.waited).toEqual([])
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("backs off between attempts and stops lengthening the wait", async () => {
    const clock = waiter()
    let attempts = 0
    const connect = vi.fn(async () => {
      attempts += 1
      if (attempts < 5) throw new Error("Cannot reach that machine")
      return "connection"
    })

    await expect(reconnectMachine({
      connect,
      wait: clock.wait,
      attempts: 8,
      initialDelayMs: 500,
      maximumDelayMs: 2_000,
    })).resolves.toBe("connection")
    expect(clock.waited).toEqual([500, 1_000, 2_000, 2_000])
  })

  it("never waits longer than the cap, even on the first retry", async () => {
    const clock = waiter()
    let attempts = 0
    const connect = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new Error("Cannot reach that machine")
      return "connection"
    })

    await expect(reconnectMachine({
      connect,
      wait: clock.wait,
      attempts: 5,
      initialDelayMs: 30_000,
      maximumDelayMs: 2_000,
    })).resolves.toBe("connection")
    expect(clock.waited).toEqual([2_000, 2_000])
  })

  it("gives up after the attempt limit without quoting the failure", async () => {
    const clock = waiter()
    const credential = "n".repeat(43)
    const connect = vi.fn(async () => {
      throw new Error(`Request with ${credential} failed`)
    })

    await expect(reconnectMachine({ connect, wait: clock.wait, attempts: 3 }))
      .rejects.toThrow("That machine could not be reached again")
    expect(connect).toHaveBeenCalledTimes(3)
  })

  it("stops at once when the machine refuses the credential", async () => {
    const clock = waiter()
    const connect = vi.fn(async () => {
      throw new DaemonRpcError(daemonAuthenticationErrorCode, "Daemon authentication failed")
    })

    await expect(reconnectMachine({ connect, wait: clock.wait, attempts: 5 }))
      .rejects.toThrow(MachineReconnectError)
    await expect(reconnectMachine({ connect, wait: clock.wait, attempts: 5 }))
      .rejects.toThrow("That machine no longer accepts this device")
    expect(connect).toHaveBeenCalledTimes(2)
    expect(clock.waited).toEqual([])
  })
})

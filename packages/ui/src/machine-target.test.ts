import { describe, expect, it, vi } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { resolveMachineTarget } from "./machine-target.js"

const credential = "n".repeat(43)

const machine: FleetMachine = {
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  protocolVersion: "0.1.0",
  transports: [
    { kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true },
  ],
  health: "healthy",
  self: false,
}

describe("resolveMachineTarget", () => {
  it("names the transport that answered and the credential it answered for", async () => {
    const closed: string[] = []
    const connect = vi.fn(async (input: { candidates: FleetMachine["transports"] }) => ({
      transport: input.candidates[0]!,
      close: () => closed.push("closed"),
    }))

    await expect(resolveMachineTarget({
      machine,
      readCredential: vi.fn(async () => credential),
      connect,
      wait: vi.fn(async () => {}),
    })).resolves.toEqual({
      machineId: machine.id,
      endpoint: "wss://studio.tailnet:47831/rpc",
      credential,
    })
    // The probe proves the machine answers; the shell opens its own connection.
    expect(closed).toEqual(["closed"])
  })

  it("closes the probe even when the machine is refused afterwards", async () => {
    const closed: string[] = []
    const connect = vi.fn(async (input: { candidates: FleetMachine["transports"] }) => ({
      transport: { ...input.candidates[0]!, endpoint: "http://studio.tailnet/rpc" },
      close: () => closed.push("closed"),
    }))

    await expect(resolveMachineTarget({
      machine,
      readCredential: vi.fn(async () => credential),
      connect,
      wait: vi.fn(async () => {}),
    })).rejects.toThrow("That machine answered on an address this client cannot use")
    expect(closed).toEqual(["closed"])
  })

  it("refuses a machine the menu would not offer without reading a credential", async () => {
    const readCredential = vi.fn(async () => credential)

    await expect(resolveMachineTarget({
      machine: { ...machine, health: "unreachable" },
      readCredential,
      connect: vi.fn(),
      wait: vi.fn(async () => {}),
    })).rejects.toThrow("That machine cannot be reached")
    expect(readCredential).not.toHaveBeenCalled()
  })
})

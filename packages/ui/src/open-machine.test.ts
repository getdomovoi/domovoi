import { describe, expect, it, vi } from "vitest"

import {
  daemonAuthenticationErrorCode,
  machineCredentialMissingErrorCode,
  type FleetMachine,
} from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"
import { MachineOpenError, openMachine } from "./open-machine.js"

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

function opening(overrides: {
  readCredential?: (machineId: string) => Promise<string>
  connect?: (input: { candidates: FleetMachine["transports"]; credential: string }) => Promise<string>
} = {}) {
  return {
    readCredential: overrides.readCredential ?? vi.fn(async () => credential),
    connect: overrides.connect ?? vi.fn(async () => "connection"),
    wait: vi.fn(async () => {}),
  }
}

describe("openMachine", () => {
  it("dials the machine with the credential kept for it", async () => {
    const io = opening()

    await expect(openMachine({ machine, ...io })).resolves.toBe("connection")
    expect(io.readCredential).toHaveBeenCalledWith(machine.id)
    expect(io.connect).toHaveBeenCalledWith({
      candidates: machine.transports,
      credential,
    })
  })

  it("never dials a machine the menu would not offer", async () => {
    const io = opening()

    await expect(openMachine({ machine: { ...machine, health: "unreachable" }, ...io }))
      .rejects.toThrow("That machine cannot be reached")
    expect(io.readCredential).not.toHaveBeenCalled()
    expect(io.connect).not.toHaveBeenCalled()
  })

  it("reports a missing credential as needing pairing again", async () => {
    const io = opening({
      readCredential: vi.fn(async () => {
        throw new DaemonRpcError(
          machineCredentialMissingErrorCode,
          "No credential is kept for that machine",
        )
      }),
    })

    await expect(openMachine({ machine, ...io }))
      .rejects.toThrow("That machine has to be paired again")
    expect(io.connect).not.toHaveBeenCalled()
  })

  it("does not blame pairing when the credential cannot be read at all", async () => {
    const io = opening({
      readCredential: vi.fn(async () => {
        throw new Error("Keychain is locked")
      }),
    })

    await expect(openMachine({ machine, ...io }))
      .rejects.toThrow("The credential for that machine could not be read")
    expect(io.connect).not.toHaveBeenCalled()
  })

  it("never quotes the credential when dialing fails", async () => {
    const io = opening({
      connect: vi.fn(async () => {
        throw new Error(`Handshake with ${credential} failed`)
      }),
    })

    await expect(openMachine({ machine, ...io, attempts: 2 }))
      .rejects.toThrow("That machine could not be reached again")
  })

  it("stops without retrying when the machine has revoked this device", async () => {
    const connect = vi.fn(async () => {
      throw new DaemonRpcError(daemonAuthenticationErrorCode, "Daemon authentication failed")
    })
    const io = opening({ connect })

    await expect(openMachine({ machine, ...io, attempts: 5 }))
      .rejects.toThrow("That machine no longer accepts this device")
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("reports a refused machine as a machine failure, not a dial failure", async () => {
    const io = opening({ readCredential: vi.fn(async () => credential) })

    await expect(openMachine({ machine: { ...machine, transports: [] }, ...io }))
      .rejects.toThrow(MachineOpenError)
  })
})

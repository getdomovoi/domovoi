import { describe, expect, it } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { machineAttachment, machineSelection, remoteControlRefusal } from "./machine-selection.js"

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

describe("machineSelection", () => {
  it("offers a healthy machine", () => {
    expect(machineSelection(machine)).toEqual({ selectable: true })
  })

  it("offers a machine that is reconnecting, because it is coming back", () => {
    expect(machineSelection({ ...machine, health: "reconnecting" }))
      .toEqual({ selectable: true })
  })

  it("refuses a machine nothing can reach", () => {
    expect(machineSelection({ ...machine, health: "unreachable" }))
      .toEqual({ selectable: false, reason: "That machine cannot be reached" })
  })

  it("refuses a machine speaking another protocol", () => {
    expect(machineSelection({ ...machine, health: "version-mismatch" }))
      .toEqual({
      selectable: false,
      reason: "That machine speaks a newer protocol version, so update Domovoi here",
    })
  })

  it("refuses a machine that has to be upgraded first", () => {
    expect(machineSelection({ ...machine, health: "upgrade-required" }))
      .toEqual({ selectable: false, reason: "That machine has to be upgraded first" })
  })

  it("refuses a machine that is not responding", () => {
    expect(machineSelection({ ...machine, health: "degraded" }))
      .toEqual({ selectable: false, reason: "That machine is not responding" })
  })

  it("refuses a machine with no transport this client may dial", () => {
    expect(machineSelection({ ...machine, transports: [] }))
      .toEqual({ selectable: false, reason: "That machine advertises no usable transport" })
  })

  it("says the target refused this machine's credential and pairing again is the fix", () => {
    expect(machineSelection({ ...machine, health: "pairing-required" }))
      .toEqual({ selectable: false, reason: "That machine refused this machine's credential, so pair it again" })
  })

  it("says a keychain that cannot be read is not a pairing problem", () => {
    expect(machineSelection({ ...machine, health: "credential-store-unavailable" }))
      .toEqual({ selectable: false, reason: "The keychain here could not be read, which pairing again would not fix" })
  })
})

describe("machineAttachment", () => {
  it("refuses every remote machine because no client credential exists for it", () => {
    expect(machineAttachment(machine)).toEqual({ selectable: false, reason: remoteControlRefusal })
    expect(remoteControlRefusal).toContain("its own device credential")
    expect(remoteControlRefusal).toContain("not part of this release")
  })

  it("refuses a remote machine for the credential before its health", () => {
    expect(machineAttachment({ ...machine, health: "unreachable" }))
      .toEqual({ selectable: false, reason: remoteControlRefusal })
  })

  it("always offers this machine, since returning home dials nothing", () => {
    expect(machineAttachment({ ...machine, self: true })).toEqual({ selectable: true })
    expect(machineAttachment({ ...machine, self: true, health: "unreachable" })).toEqual({ selectable: true })
  })
})

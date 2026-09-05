import { fleetHealthSchema, type FleetEntry, type FleetMachine } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { machineRows } from "./machine-rows"

const machine: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "tailnet",
  capabilities: ["sessions"],
  protocolVersion: "0.2.0",
  transports: [],
  heartbeat: { state: "online", lastSeenAt: "2026-09-04T12:00:00.000Z" },
  health: "healthy",
  self: false,
}

function entries(...machines: FleetMachine[]): FleetEntry[] {
  return machines.map((candidate) => ({ kind: "machine", machine: candidate }))
}

const pending: FleetEntry = {
  kind: "pending",
  id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
  machineId: `machine-${"b".repeat(32)}`,
  operation: "enroll",
  startedAt: "2026-09-04T12:00:00.000Z",
}

const unenrolled: FleetEntry = { kind: "unenrolled", machineId: `machine-${"c".repeat(32)}` }

describe("machineRows", () => {
  it("badges only the states that want something from a person", () => {
    expect(machineRows(entries(machine))[0]?.badge).toBeUndefined()
    expect(machineRows(entries({ ...machine, health: "unreachable" }))[0])
      .toMatchObject({ health: "gone", badge: "Unreachable" })
  })

  it("classifies every health the daemon can report", () => {
    for (const health of fleetHealthSchema.options) {
      const row = machineRows(entries({ ...machine, health }))[0]
      expect(row?.health).toBeDefined()
      expect(row?.platform).not.toContain("undefined")
    }
  })

  it("tells the operator to update this device on a version mismatch", () => {
    // version-mismatch means the remote is ahead, so the phone is the old one.
    expect(machineRows(entries({ ...machine, health: "version-mismatch" }))[0]?.badge)
      .toBe("Update this device")
  })

  it("says the target refused the daemon's credential and pairing again is the fix", () => {
    expect(machineRows(entries({ ...machine, health: "pairing-required" }))[0]).toMatchObject({
      health: "gone",
      badge: "Pair again",
      note: "workshop refused the credential the daemon holds for it. Pair it again from the daemon to restore it.",
    })
  })

  it("says a keychain the daemon cannot read is not a pairing problem", () => {
    expect(machineRows(entries({ ...machine, health: "credential-store-unavailable" }))[0]).toMatchObject({
      health: "busy",
      badge: "Keychain unavailable",
      note: "The daemon's keychain could not be read, so nothing was presented to workshop. Pairing again would not fix it.",
    })
  })

  it("shows an enrollment in progress in place, as the daemon's to finish", () => {
    expect(machineRows([pending])[0]).toEqual({
      id: pending.machineId,
      label: "Enrolling",
      platform: "machine-bbbbbbbb…",
      health: "busy",
      badge: "In progress",
      note: "This daemon resumes it on its own.",
    })
    expect(machineRows([{ ...pending, operation: "forget" }])[0]?.label).toBe("Forgetting")
  })

  it("says an unenrolled credential exists and how to enroll the machine", () => {
    expect(machineRows([unenrolled])[0]).toEqual({
      id: unenrolled.machineId,
      label: "Never enrolled",
      platform: "machine-cccccccc…",
      health: "gone",
      badge: "Unenrolled",
      note: "A credential exists but this machine was never enrolled. Pair it again from the daemon to enroll it.",
    })
  })

  it("keeps the daemon's order across every kind of entry", () => {
    expect(machineRows([pending, ...entries(machine), unenrolled]).map((row) => row.id))
      .toEqual([pending.machineId, machine.id, unenrolled.machineId])
  })
})

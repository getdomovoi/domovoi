import {
  fleetConnectionKindSchema,
  fleetHealthSchema,
  type FleetEntry,
  type FleetMachine,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import type { MachineActivity } from "./machine-activity"
import { fleetSummary, machineRows } from "./machine-rows"

const lastSeenAt = "2026-09-04T12:00:00.000Z"
const now = Date.parse("2026-09-04T12:12:00.000Z")

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
  heartbeat: { state: "online", lastSeenAt },
  health: "healthy",
  self: false,
}

function entries(...machines: FleetMachine[]): FleetEntry[] {
  return machines.map((candidate) => ({ kind: "machine", machine: candidate }))
}

function row(candidate: Partial<FleetMachine>, activity?: MachineActivity) {
  return machineRows(entries({ ...machine, ...candidate }), now, activity)[0]
}

const pending: FleetEntry = {
  kind: "pending",
  id: "3d5b7a2e-4c1f-4a6b-9e2d-8f7c6b5a4d3e",
  machineId: `machine-${"b".repeat(32)}`,
  operation: "enroll",
  startedAt: lastSeenAt,
}

const unenrolled: FleetEntry = { kind: "unenrolled", machineId: `machine-${"c".repeat(32)}` }

describe("machineRows", () => {
  it("badges a healthy machine with the route it is reached on", () => {
    expect(row({ connection: "tailnet" })?.badge).toBe("Tailnet")
    expect(row({ connection: "lan" })?.badge).toBe("LAN")
  })

  it("calls the machine this phone is talking to the daemon, not a route", () => {
    expect(row({ self: true, connection: "local" })?.badge).toBe("This daemon")
  })

  it("has a word for every route the daemon can report", () => {
    for (const connection of fleetConnectionKindSchema.options) {
      const badge = row({ connection })?.badge
      expect(badge).toBeTruthy()
      expect(badge).not.toContain("undefined")
    }
  })

  it("lets a state that wants a person displace the route badge", () => {
    expect(row({ health: "unreachable" })).toMatchObject({ health: "gone", badge: "Offline" })
    expect(row({ health: "pairing-required" })?.badge).toBe("Pair again")
  })

  it("classifies every health the daemon can report", () => {
    for (const health of fleetHealthSchema.options) {
      const graded = row({ health })
      expect(graded?.health).toBeDefined()
      expect(graded?.badge).toBeTruthy()
      expect(graded?.platform).not.toContain("undefined")
    }
  })

  it("tells the operator to update this device on a version mismatch", () => {
    // version-mismatch means the remote is ahead, so the phone is the old one.
    expect(row({ health: "version-mismatch" })?.badge).toBe("Update this device")
  })

  it("says the target refused the daemon's credential and pairing again is the fix", () => {
    expect(row({ health: "pairing-required" })).toMatchObject({
      health: "gone",
      note: "workshop refused the credential the daemon holds for it. Pair it again from the daemon to restore it.",
    })
  })

  it("says a keychain the daemon cannot read is not a pairing problem", () => {
    expect(row({ health: "credential-store-unavailable" })).toMatchObject({
      health: "busy",
      badge: "Keychain unavailable",
      note: "The daemon's keychain could not be read, so nothing was presented to workshop. Pairing again would not fix it.",
    })
  })

  it("says when a machine that stopped answering was last heard from", () => {
    expect(row({ health: "unreachable" })?.note)
      .toBe("workshop cannot be reached. Last seen 12m ago.")
    expect(row({ health: "degraded" })?.note)
      .toBe("workshop is not responding. Last seen 12m ago.")
    expect(row({
      health: "unreachable",
      heartbeat: { state: "offline", lastSeenAt: "2026-09-04T12:11:30.000Z" },
    })?.note).toBe("workshop cannot be reached. Last seen just now.")
  })

  it("does not invent an age from a timestamp it cannot read", () => {
    expect(row({
      health: "unreachable",
      heartbeat: { state: "offline", lastSeenAt: "not-a-time" },
    })?.note).toBe("workshop cannot be reached.")
  })

  it("names the distribution of a daemon running inside WSL", () => {
    expect(row({ wsl: { distribution: "Ubuntu-24.04", version: 2 } })?.platform)
      .toBe("Ubuntu-24.04 (WSL) · x64 · 0.0.1")
    expect(row({})?.platform).toBe("linux · x64 · 0.0.1")
  })

  it("counts sessions and tools only for the machine those counts describe", () => {
    const activity: MachineActivity = {
      machineId: machine.id,
      sessions: 3,
      tools: "1 approval",
      attention: true,
    }
    expect(row({}, activity)?.stats).toEqual([
      { label: "Sessions", value: "3", attention: false },
      { label: "Tools", value: "1 approval", attention: true },
    ])
    // A snapshot describing another machine cannot lend this one its work.
    expect(row({ id: `machine-${"d".repeat(32)}` }, activity)?.stats).toEqual([])
    expect(row({})?.stats).toEqual([])
  })

  it("offers to open only the machine this phone is connected to", () => {
    expect(row({ self: true })?.action).toBe("open")
    expect(row({ self: false })?.action).toBeUndefined()
    // Nothing in the protocol wakes a machine, so a silent one offers nothing.
    expect(row({ health: "unreachable" })?.action).toBeUndefined()
  })

  it("shows an enrollment in progress in place, as the daemon's to finish", () => {
    expect(machineRows([pending], now)[0]).toEqual({
      id: pending.machineId,
      label: "Enrolling",
      platform: "machine-bbbbbbbb…",
      health: "busy",
      badge: "In progress",
      note: "This daemon resumes it on its own.",
      stats: [],
      action: undefined,
    })
    expect(machineRows([{ ...pending, operation: "forget" }], now)[0]?.label).toBe("Forgetting")
  })

  it("says an unenrolled credential exists and how to enroll the machine", () => {
    expect(machineRows([unenrolled], now)[0]).toEqual({
      id: unenrolled.machineId,
      label: "Never enrolled",
      platform: "machine-cccccccc…",
      health: "gone",
      badge: "Unenrolled",
      note: "A credential exists but this machine was never enrolled. Pair it again from the daemon to enroll it.",
      stats: [],
      action: undefined,
    })
  })

  it("keeps the daemon's order across every kind of entry", () => {
    expect(machineRows([pending, ...entries(machine), unenrolled], now).map((entry) => entry.id))
      .toEqual([pending.machineId, machine.id, unenrolled.machineId])
  })
})

describe("fleetSummary", () => {
  it("counts what answers, what has stopped, and what wants a person", () => {
    expect(fleetSummary([
      ...entries(
        machine,
        { ...machine, id: `machine-${"d".repeat(32)}` },
        { ...machine, id: `machine-${"e".repeat(32)}`, health: "unreachable" },
        { ...machine, id: `machine-${"f".repeat(32)}`, health: "pairing-required" },
      ),
      pending,
    ])).toBe("2 reachable · 1 offline · 2 need attention")
  })

  it("says only the counts that are not zero", () => {
    expect(fleetSummary(entries(machine))).toBe("1 reachable")
    expect(fleetSummary(entries({ ...machine, health: "degraded" }))).toBe("1 needs attention")
  })

  it("says nothing about a fleet with no entries, because the list already does", () => {
    expect(fleetSummary([])).toBeUndefined()
  })
})

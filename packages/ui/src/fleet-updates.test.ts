import type { FleetMachine } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import { fleetUpdateAvailable, newestFleetVersion } from "./fleet-updates.js"

function machine(id: string, version: string): FleetMachine {
  return {
    id: `machine-${id.padEnd(32, "0")}`,
    label: id,
    platform: "linux",
    arch: "x64",
    version,
    connection: "lan",
    capabilities: ["sessions"],
    heartbeat: { state: "online", lastSeenAt: "2026-09-03T12:00:00.000Z" },
    protocolVersion: "0.1.0",
    transports: [],
    health: "healthy",
    self: false,
  }
}

const fleet = [machine("host", "0.14.2"), machine("behind", "0.14.0"), machine("also", "0.14.2")]

it("names the newest daemon the fleet is running", () => {
  expect(newestFleetVersion(fleet)).toBe("0.14.2")
})

it("marks only the machines behind that version", () => {
  expect(fleetUpdateAvailable(machine("behind", "0.14.0"), fleet)).toBe("0.14.2")
  expect(fleetUpdateAvailable(machine("host", "0.14.2"), fleet)).toBeUndefined()
})

it("says nothing when a machine runs ahead of the rest", () => {
  expect(fleetUpdateAvailable(machine("ahead", "0.15.0"), fleet)).toBeUndefined()
})

it("compares numerically rather than as text", () => {
  const wide = [machine("a", "0.9.0"), machine("b", "0.10.0")]

  expect(newestFleetVersion(wide)).toBe("0.10.0")
  expect(fleetUpdateAvailable(machine("a", "0.9.0"), wide)).toBe("0.10.0")
})

it("says nothing when a version is not a version", () => {
  const odd = [machine("a", "0.14.2"), machine("b", "nightly")]

  expect(newestFleetVersion(odd)).toBe("0.14.2")
  expect(fleetUpdateAvailable(machine("b", "nightly"), odd)).toBeUndefined()
})

it("says nothing about a fleet of one", () => {
  expect(fleetUpdateAvailable(machine("only", "0.14.0"), [machine("only", "0.14.0")])).toBeUndefined()
})

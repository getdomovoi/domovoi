import { describe, expect, it } from "vitest"

import type { FleetMachine } from "./fleet.js"
import {
  transferPreflight,
  transferRefusalMessage,
  transferRefusalSchema,
} from "./transfer-preflight.js"

const source: FleetMachine = {
  id: `machine-${"a".repeat(32)}`,
  label: "workshop",
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
  connection: "local",
  capabilities: ["sessions", "terminals"],
  protocolVersion: "0.1.0",
  transports: [
    { kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
  ],
  heartbeat: { state: "online", lastSeenAt: "2026-08-31T12:00:00.000Z" },
  health: "healthy",
  self: true,
}

const target: FleetMachine = {
  ...source,
  id: `machine-${"b".repeat(32)}`,
  label: "studio",
  connection: "tailnet",
  self: false,
}

describe("transferPreflight", () => {
  it("allows a transfer to a healthy machine that runs sessions", () => {
    expect(transferPreflight({ source, target })).toEqual({ allowed: true })
  })

  it("refuses an offline target immediately rather than queueing it", () => {
    expect(transferPreflight({ source, target: { ...target, health: "unreachable" } }))
      .toEqual({ allowed: false, reason: "target-unreachable" })
  })

  it("refuses a target that is not answering right now", () => {
    for (const health of ["degraded", "reconnecting"] as const) {
      expect(transferPreflight({ source, target: { ...target, health } }))
        .toEqual({ allowed: false, reason: "target-not-responding" })
    }
  })

  it("refuses a target the client cannot speak to", () => {
    expect(transferPreflight({ source, target: { ...target, health: "version-mismatch" } }))
      .toEqual({ allowed: false, reason: "target-version-mismatch" })
    expect(transferPreflight({ source, target: { ...target, health: "upgrade-required" } }))
      .toEqual({ allowed: false, reason: "target-upgrade-required" })
  })

  it("explains when the machine must be paired again", () => {
    expect(transferRefusalSchema.safeParse("target-pairing-required").success).toBe(true)
    expect(transferRefusalMessage["target-pairing-required"])
      .toBe("That machine must be paired again before a session can move to it")
  })

  it.each([
    ["pairing-required", "target-pairing-required"],
    ["credential-store-unavailable", "target-unreachable"],
  ] as const)("refuses a target with %s health", (health, reason) => {
    expect(transferPreflight({ source, target: { ...target, health } }))
      .toEqual({ allowed: false, reason })
  })

  it("refuses a target that cannot run sessions", () => {
    expect(transferPreflight({ source, target: { ...target, capabilities: ["terminals"] } }))
      .toEqual({ allowed: false, reason: "target-cannot-run-sessions" })
  })

  it("refuses a transfer to the machine already holding the session", () => {
    expect(transferPreflight({ source, target: source }))
      .toEqual({ allowed: false, reason: "target-is-source" })
  })

  it("names every refusal in words a person can act on", () => {
    for (const reason of transferRefusalSchema.options) {
      expect(transferRefusalMessage[reason].length).toBeGreaterThan(0)
    }
    expect(transferRefusalMessage["target-unreachable"])
      .toBe("That machine is unreachable, so the session cannot move to it now")
  })
})

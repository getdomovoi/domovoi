import { describe, expect, it } from "vitest"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"

import { collectStatus, renderStatus } from "./status.js"

const machineId = `machine-${"d".repeat(32)}`
const snapshot = { ...demoWorkspace, machine: { ...demoWorkspace.machine, name: "studio" } }
const hetzner = (health: string) => ({
  kind: "machine",
  machine: {
    id: machineId, label: "hetzner", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    capabilities: ["sessions"], transports: [], self: false, health, connection: "direct",
    heartbeat: { state: "online", lastSeenAt: "2026-09-11T12:00:00.000Z" },
    verifiedRoute: { endpoint: "wss://hetzner.tailnet:47831/rpc", lastAuthenticatedAt: "2026-09-11T12:00:00.000Z" },
  },
})

describe("status", () => {
  it("reads the route the daemon would choose for each fleet machine", async () => {
    const calls: string[] = []
    const call = async (method: string) => {
      calls.push(method)
      switch (method) {
        case "workspace.get": return snapshot
        case "fleet.list": return { entries: [hetzner("healthy")] }
        case "fleet.clientRoute": return { outcome: "ready", machineId, transport: { kind: "lan", endpoint: "wss://hetzner.tailnet:47831/rpc", authenticated: true } }
        default: throw new Error(method)
      }
    }
    const report = await collectStatus({ endpoint: "ws://127.0.0.1:47831/rpc", call })
    expect(calls).toContain("fleet.clientRoute")
    expect(report.fleet[0]).toMatchObject({ label: "hetzner", route: "lan wss://hetzner.tailnet:47831/rpc" })
    expect(report.sessions.total).toBe(demoWorkspace.sessions.length)
    const text = renderStatus(report)
    expect(text).toMatch(/^daemon\s+studio/)
    expect(text).toMatch(/hetzner.*lan wss:\/\/hetzner\.tailnet:47831\/rpc/)
  })

  it("shows a refusal as a refusal, not as an empty route", async () => {
    const call = async (method: string) => {
      switch (method) {
        case "workspace.get": return snapshot
        case "fleet.list": return { entries: [hetzner("unreachable")] }
        case "fleet.clientRoute": return { outcome: "refused", reason: "machine-unavailable" }
        default: throw new Error(method)
      }
    }
    const report = await collectStatus({ endpoint: "ws://127.0.0.1:47831/rpc", call })
    expect(report.fleet[0]?.route).toBe("refused: machine-unavailable")
  })
})

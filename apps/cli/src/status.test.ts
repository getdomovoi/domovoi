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

// A newline, an escape sequence and a right-to-left override, built from code
// points so the source shows which invisible character each is.
const hostile = `\nX\u001b[31mY${String.fromCodePoint(0x202e)}Z`
const shown = "\\nX\\e[31mY\\u{202e}Z"

describe("status, with daemon text that carries control characters", () => {
  it("shows each one escaped and keeps one fact per line", async () => {
    const call = async (method: string) => {
      switch (method) {
        case "workspace.get": return { ...snapshot, machine: { ...snapshot.machine, name: `studio${hostile}`, version: `0.9${hostile}`, platform: `darwin${hostile}` } }
        case "fleet.list": return { entries: [{ ...hetzner("healthy"), machine: { ...hetzner("healthy").machine, label: `hetzner${hostile}` } }] }
        case "fleet.clientRoute": throw new Error(`socket closed${hostile}`)
        default: throw new Error(method)
      }
    }
    const report = await collectStatus({ endpoint: `ws://127.0.0.1:47831/rpc${hostile}`, call })
    const text = renderStatus(report)
    expect(text.split("\n")).toEqual([
      `daemon    studio${shown} (${snapshot.machine.id})`,
      `endpoint  ws://127.0.0.1:47831/rpc${shown}`,
      `version   0.9${shown}, protocol ${snapshot.protocolVersion}, darwin${shown}`,
      expect.stringMatching(/^sessions {2}\d+/),
      "fleet",
      `  ${`hetzner${shown}`.padEnd(24)} ${"healthy".padEnd(10)} unknown: socket closed${shown}`,
      "",
    ])
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain(String.fromCodePoint(0x202e))
  })

  it("leaves names in any script unchanged", async () => {
    const call = async (method: string) => {
      switch (method) {
        case "workspace.get": return { ...snapshot, machine: { ...snapshot.machine, name: "סטודיו-café" } }
        case "fleet.list": return { entries: [{ ...hetzner("healthy"), machine: { ...hetzner("healthy").machine, label: "хетцнер" } }] }
        case "fleet.clientRoute": return { outcome: "refused", reason: "machine-unavailable" }
        default: throw new Error(method)
      }
    }
    const text = renderStatus(await collectStatus({ endpoint: "ws://127.0.0.1:47831/rpc", call }))
    expect(text).toMatch(/^daemon {4}סטודיו-café \(/m)
    expect(text).toMatch(/^ {2}хетцнер {18}healthy {4}refused: machine-unavailable$/m)
  })
})

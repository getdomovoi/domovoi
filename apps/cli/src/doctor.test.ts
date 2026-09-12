import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { diagnose, renderDoctor } from "./doctor.js"

const machineId = `machine-${"d".repeat(32)}`
const deviceId = `device-${"1".repeat(32)}`
const snapshot = { ...demoWorkspace, machine: { ...demoWorkspace.machine, name: "studio" } }
const current = { kind: "client", machineId: demoWorkspace.machine.id, deviceId, client: "cli" }
const fleetMachine = (overrides: Record<string, unknown> = {}) => ({
  kind: "machine",
  machine: {
    id: machineId, label: "hetzner", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
    capabilities: ["sessions"], transports: [{ kind: "tailnet", endpoint: "wss://hetzner.tailnet:47831/rpc", authenticated: true }],
    self: false, health: "healthy", connection: "direct",
    heartbeat: { state: "online", lastSeenAt: "2026-09-12T12:00:00.000Z" },
    verifiedRoute: { endpoint: "wss://hetzner.tailnet:47831/rpc", lastAuthenticatedAt: "2026-09-12T12:00:00.000Z" },
    ...overrides,
  },
})

function daemon(routes: Record<string, unknown>, entries: unknown[] = [fleetMachine()]) {
  return async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "workspace.get": return snapshot
      case "device.current": return current
      case "fleet.list": return { entries }
      case "fleet.clientRoute": return routes[String(params.machineId)] ?? { outcome: "refused", reason: "client-route-unavailable" }
      default: throw new Error(method)
    }
  }
}

describe("doctor", () => {
  it("reports the route that won and why the others lost", async () => {
    const report = await diagnose({
      endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion,
      call: daemon({ [machineId]: { outcome: "ready", machineId, transport: { kind: "tailnet", endpoint: "wss://hetzner.tailnet:47831/rpc", authenticated: true } } }),
    })
    const hetzner = report.machines[0]!
    expect(hetzner.route).toBe("tailnet wss://hetzner.tailnet:47831/rpc")
    expect(hetzner.because).toEqual(["verified route matched", "local: not advertised", "wsl: not a WSL guest of this host", "lan: not advertised", "ssh: no tunnel configured here", "relay: not implemented"])
    expect(report.failed).toBe(false)
    expect(renderDoctor(report)).toMatch(/hetzner.*tailnet wss:\/\/hetzner\.tailnet:47831\/rpc/)
  })

  it("names why a machine cannot be reached, and fails the run", async () => {
    const report = await diagnose({
      endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion,
      call: daemon({ [machineId]: { outcome: "refused", reason: "pairing-required" } }, [fleetMachine({ verifiedRoute: undefined, connection: "lan", transports: [
        { kind: "lan", endpoint: "wss://hetzner.local:47831/rpc", authenticated: true },
        { kind: "relay", endpoint: "wss://relay.example/rpc", authenticated: true },
      ] })]),
    })
    const hetzner = report.machines[0]!
    expect(hetzner.route).toBe("refused: pairing-required")
    expect(hetzner.because).toEqual(["no verified route yet", "local: not advertised", "wsl: not a WSL guest of this host", "lan wss://hetzner.local:47831/rpc: advertised, not chosen", "tailnet: not advertised", "ssh: no tunnel configured here", "relay: not implemented", "this daemon holds no machine credential for it; pair the machines"])
    expect(report.failed).toBe(true)
  })

  it("reports the protocol as a fact and negotiation as unknown until S1.2", async () => {
    const report = await diagnose({ endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: "9.9.9", call: daemon({}) })
    const probe = report.probes.find((entry) => entry.name === "protocol")!
    expect(probe.detail).toBe(`client 9.9.9, daemon ${protocolVersion}; negotiation: unknown until version negotiation lands`)
    expect(probe.ok).toBe(false)
    expect(report.failed).toBe(true)
  })

  it("lists the daemon itself as this connection, not as a route to choose", async () => {
    const report = await diagnose({ endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion,
      call: daemon({}, [fleetMachine({ id: demoWorkspace.machine.id, label: "studio", self: true, connection: "local", verifiedRoute: undefined, transports: [] })]) })
    expect(report.machines[0]).toMatchObject({ label: "studio", route: "this daemon, ws://127.0.0.1:47831/rpc", because: [] })
    expect(report.failed).toBe(false)
  })

  it("reports the credential as the device it names", async () => {
    const report = await diagnose({ endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion, call: daemon({}) , })
    const probe = report.probes.find((entry) => entry.name === "credential")!
    expect(probe.ok).toBe(true)
    expect(probe.detail).toContain(deviceId)
  })
})

describe("doctor, after peer review", () => {
  it("asks for source-local routes only when the daemon itself is on loopback", async () => {
    const seen: Record<string, unknown>[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === "fleet.clientRoute") seen.push(params)
      return daemon({ [machineId]: { outcome: "refused", reason: "client-route-unavailable" } })(method, params)
    }
    await diagnose({ endpoint: "wss://remote.example/rpc", clientProtocolVersion: protocolVersion, call })
    await diagnose({ endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion, call })
    expect(seen.map((params) => params.allowSourceLocal)).toEqual([false, true])
  })

  it("does not claim to know the daemon host's tunnel configuration", async () => {
    const report = await diagnose({
      endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion,
      call: daemon({ [machineId]: { outcome: "ready", machineId, transport: { kind: "ssh", endpoint: "ws://127.0.0.1:1234/rpc", authenticated: true, configured: true } } },
        [fleetMachine({ verifiedRoute: undefined, connection: "lan", transports: [] })]),
    })
    const hetzner = report.machines[0]!
    expect(hetzner.route).toBe("ssh ws://127.0.0.1:1234/rpc")
    expect(hetzner.because).not.toContain("ssh: no tunnel configured here")
    expect(hetzner.because).toContain("ssh: chosen; tunnels are configured on the daemon host, not advertised")
    expect(report.failed).toBe(false)
  })

  it("judges loopback by the parsed hostname, as the daemon does", async () => {
    const report = await diagnose({
      endpoint: "ws://127.0.0.1:47831/rpc", clientProtocolVersion: protocolVersion,
      call: daemon({ [machineId]: { outcome: "refused", reason: "client-route-unavailable" } }, [fleetMachine({ verifiedRoute: undefined, connection: "lan", transports: [
        { kind: "lan", endpoint: "wss://localhost.remote.example:47831/rpc", authenticated: true },
      ] })]),
    })
    const because = report.machines[0]!.because
    // A hostname that merely starts with "localhost" is not loopback; the
    // protocol refuses real loopback hosts on remote transports before doctor
    // sees them, so the only spelling doctor can meet is this one.
    expect(because).toContain("lan wss://localhost.remote.example:47831/rpc: advertised, not chosen")
    expect(because.some((line) => line.includes("never trusted"))).toBe(false)
  })
})

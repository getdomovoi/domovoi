import { daemonAuthenticationErrorCode, devicePairResultSchema, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { machineCredentialDigest } from "./machine-credentials.js"
import { fleetProductionHarness, persistedRegistry } from "./test-fleet-production.js"

const { cleanup, machine, enroll, connect } = fleetProductionHarness()
afterEach(cleanup)

describe("real remote client admission", () => {
  it("keeps the issuer honest while granting a different client kind", async () => {
    const target = await machine("target")
    const granted = devicePairResultSchema.parse(await target.root.ok("device.pair", { client: "cli", targetClient: "desktop", label: "Laptop desktop" }))
    expect(granted.device.binding).toEqual({ kind: "client", client: "desktop" })
    const desktop = await connect(target.address.url)
    await desktop.ok("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: granted.token })
    expect(await desktop.ok("device.current", {})).toEqual({
      kind: "client", machineId: target.id, deviceId: granted.device.id, client: "desktop",
    })
    expect(await target.root.ok("device.current", {})).toEqual({ kind: "daemon", machineId: target.id })
    expect((await desktop.call("device.pair", { label: "extra", client: "desktop", targetClient: "desktop" })).error?.code)
      .toBe(daemonAuthenticationErrorCode)
    expect((await desktop.call("device.pair", { label: "spoof", client: "cli", targetClient: "desktop" })).error?.code)
      .toBe(-32602)
  })

  it("resolves an enrolled route with a machine credential but never returns that credential", async () => {
    const source = await machine("source")
    const target = await machine("target")
    await enroll(source, target)
    const credential = source.credentials.forMachine(target.id)!
    const route = await source.root.ok("fleet.clientRoute", { machineId: target.id, allowSourceLocal: true })
    expect(route).toEqual({ outcome: "ready", machineId: target.id,
      transport: { kind: "local", endpoint: target.address.url, authenticated: true } })
    expect(JSON.stringify(route)).not.toContain(credential)
    expect(await source.root.ok("fleet.clientRoute", { machineId: target.id }))
      .toEqual({ outcome: "refused", reason: "client-route-unavailable" })

    const peer = await connect(target.address.url)
    await peer.ok("system.hello", { client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: credential })
    for (const [method, params] of [
      ["device.current", {}],
      ["device.pair", { label: "escalation", client: "desktop", targetClient: "desktop" }],
      ["fleet.clientRoute", { machineId: source.id }],
    ] as const) expect((await peer.call(method, params)).error?.code).toBe(daemonAuthenticationErrorCode)

    persistedRegistry(source.homeDirectory, (registry) => registry.stageForget(target.id, machineCredentialDigest(target.id, credential), Date.now()))
    expect(await source.root.ok("fleet.clientRoute", { machineId: target.id, allowSourceLocal: true }))
      .toEqual({ outcome: "refused", reason: "not-enrolled" })
  })
})

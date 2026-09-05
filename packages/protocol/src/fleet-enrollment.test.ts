import { describe, expect, it } from "vitest"

import { rpcMethodMutations, rpcMethods, rpcNotificationSchema } from "./rpc.js"
import { protocolVersion } from "./schema.js"
import {
  fleetEnrollParamsSchema,
  fleetEnrollRefusalSchema,
  fleetEnrollResultSchema,
  fleetForgetParamsSchema,
  fleetForgetRefusalSchema,
  fleetForgetResultSchema,
} from "./fleet-enrollment.js"
import {
  fleetDirectEndpointSchema,
  fleetChangedNotificationSchema,
  fleetEntrySchema,
  fleetMachineDescriptorSchema,
  fleetMachineSchema,
} from "./fleet.js"

const machineId = `machine-${"a".repeat(32)}`
const descriptor = {
  id: machineId,
  label: "studio",
  platform: "darwin",
  arch: "arm64",
  version: "0.0.1",
  protocolVersion,
  capabilities: ["sessions"],
  transports: [],
}
const verifiedRoute = {
  endpoint: "wss://studio.tailnet:47831/rpc",
  lastAuthenticatedAt: "2026-09-04T12:00:00.000Z",
}
const machine = {
  ...descriptor,
  self: false,
  health: "healthy",
  heartbeat: { state: "online", lastSeenAt: verifiedRoute.lastAuthenticatedAt },
  connection: "direct",
  verifiedRoute,
}
const pending = {
  kind: "pending",
  id: "12345678-1234-4234-8234-123456789abc",
  machineId,
  operation: "enroll",
  startedAt: verifiedRoute.lastAuthenticatedAt,
}

describe("fleet enrollment RPC surface", () => {
  it("enrolls, refreshes and forgets through described RPCs", () => {
    for (const method of ["fleet.enroll", "fleet.heartbeat", "fleet.forget", "device.revokeCurrent"]) {
      expect(rpcMethods).toHaveProperty(method)
    }
  })

  it("has no unverified credential import or renderer export", () => {
    expect(rpcMethods).not.toHaveProperty("device.saveCredential")
    expect(rpcMethods).not.toHaveProperty("device.machineCredential")
  })

  it("describes the persistence boundary and client fleet notification", () => {
    expect(rpcMethodMutations["fleet.enroll"]).toBe("mutating")
    expect(rpcMethodMutations["fleet.forget"]).toBe("mutating")
    expect(rpcMethodMutations["device.revokeCurrent"]).toBe("mutating")
    expect(rpcMethodMutations["fleet.heartbeat"]).toBe("read-only")
    const notification = rpcNotificationSchema.parse({
      jsonrpc: "2.0", method: "fleet.changed", params: { entries: [pending] },
    })
    expect(fleetChangedNotificationSchema.parse(notification.params)).toEqual({ entries: [pending] })
  })
})

describe("fleet descriptor and route boundaries", () => {
  it("reports only the target facts, even when it advertises no route", () => {
    expect(fleetMachineDescriptorSchema.parse(descriptor)).toEqual(descriptor)
    for (const extra of [
      { heartbeat: machine.heartbeat }, { health: "healthy" }, { connection: "local" },
      { self: true }, { verifiedRoute }, { credential: "a".repeat(43) },
    ]) {
      expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, ...extra }).success).toBe(false)
    }
    expect(fleetMachineDescriptorSchema.safeParse({ ...descriptor, capabilities: ["sessions", "sessions"] }).success).toBe(false)
  })

  it.each([
    "ws://127.0.0.1:47831/rpc", "ws://[::1]:47831/rpc", "ws://localhost:47831/rpc",
    "wss://studio.tailnet:443/rpc", "wss://192.168.1.20:47831/rpc",
  ])("accepts a protected direct endpoint %s", (endpoint) => {
    expect(fleetDirectEndpointSchema.parse(endpoint)).toBe(endpoint)
  })

  it.each([
    "ws://studio.tailnet/rpc", "https://studio.tailnet/rpc", "not a url",
    "wss://user:password@studio.tailnet/rpc", "wss://studio.tailnet/rpc?token=secret",
    "wss://studio.tailnet/rpc#secret", `wss://${"x".repeat(2048)}.test/rpc`,
  ])("rejects an unsafe or credential-bearing endpoint %s", (endpoint) => {
    expect(fleetDirectEndpointSchema.safeParse(endpoint).success).toBe(false)
  })

  it("requires proof for a direct connection and never attributes it to self", () => {
    expect(fleetMachineSchema.parse(machine)).toEqual(machine)
    const { verifiedRoute: _route, ...unproven } = machine
    expect(fleetMachineSchema.safeParse(unproven).success).toBe(false)
    expect(fleetMachineSchema.safeParse({ ...machine, self: true }).success).toBe(false)
  })

  it("requires facts for a machine row and forbids them in unresolved rows", () => {
    expect(fleetEntrySchema.safeParse({ kind: "machine", machineId }).success).toBe(false)
    expect(fleetEntrySchema.parse(pending)).toEqual(pending)
    expect(fleetEntrySchema.safeParse({ ...pending, machine }).success).toBe(false)
    expect(fleetEntrySchema.safeParse({ kind: "unenrolled", machineId, label: "guessed" }).success).toBe(false)
  })
})

describe("enrollment and forget outcomes", () => {
  const params = {
    endpoint: verifiedRoute.endpoint,
    code: "hearth-quiet-ember-42",
    sourceDeviceLabel: "studio-mac",
    client: "desktop",
  }

  it("takes a code and endpoint, with an optional expected identity for re-pairing", () => {
    expect(fleetEnrollParamsSchema.parse(params)).toEqual(params)
    expect(fleetEnrollParamsSchema.parse({ ...params, expectedMachineId: machineId }).expectedMachineId).toBe(machineId)
    for (const extra of [{ machineId }, { credential: "a".repeat(43) }, { descriptor }, { sourceDeviceLabel: " " }]) {
      expect(fleetEnrollParamsSchema.safeParse({ ...params, ...extra }).success).toBe(false)
    }
    expect(fleetForgetParamsSchema.parse({ machineId, client: "desktop" })).toEqual({ machineId, client: "desktop" })
  })

  it("reports success only with the enrolled row and no credential", () => {
    const result = { outcome: "enrolled", machineId, fleet: { entries: [{ kind: "machine", machine }] } }
    expect(fleetEnrollResultSchema.parse(result)).toEqual(result)
    expect(fleetEnrollResultSchema.safeParse({ ...result, fleet: { entries: [] } }).success).toBe(false)
    expect(fleetEnrollResultSchema.safeParse({ ...result, token: "a".repeat(43) }).success).toBe(false)
    expect(fleetEnrollResultSchema.safeParse({ ...result, fleet: { entries: [pending] } }).success).toBe(false)
    const { verifiedRoute: _route, ...withoutRoute } = machine
    for (const facts of [
      { ...withoutRoute, connection: "local", self: true },
      { ...withoutRoute, connection: "tailnet" },
    ]) {
      expect(fleetEnrollResultSchema.safeParse({
        ...result, fleet: { entries: [{ kind: "machine", machine: facts }] },
      }).success).toBe(false)
    }
  })

  it("retains a pending cross-store operation in the returned fleet", () => {
    const result = { outcome: "pending", operation: pending, fleet: { entries: [pending] } }
    expect(fleetEnrollResultSchema.parse(result)).toEqual(result)
    expect(fleetEnrollResultSchema.safeParse({ ...result, fleet: { entries: [] } }).success).toBe(false)
    expect(fleetEnrollResultSchema.safeParse({ ...result, operation: { ...pending, operation: "forget" } }).success).toBe(false)
    for (const delta of [
      { id: "12345678-1234-4234-8234-123456789abd" },
      { operation: "forget" },
      { startedAt: "2026-09-04T13:00:00.000Z" },
    ]) {
      expect(fleetEnrollResultSchema.safeParse({
        ...result, fleet: { entries: [{ ...pending, ...delta }] },
      }).success).toBe(false)
    }
  })

  it.each(["confirmed", "unconfirmed"])("states %s remote revocation separately from local deletion", (remoteRevocation) => {
    const result = { outcome: "forgotten", machineId, remoteRevocation, fleet: { entries: [] } }
    expect(fleetForgetResultSchema.parse(result)).toEqual(result)
    expect(fleetForgetResultSchema.safeParse({ ...result, fleet: { entries: [{ kind: "unenrolled", machineId }] } }).success).toBe(false)
    const forgetting = { ...pending, operation: "forget" }
    expect(fleetForgetResultSchema.parse({
      outcome: "pending", operation: forgetting, remoteRevocation, fleet: { entries: [forgetting] },
    }).outcome).toBe("pending")
  })

  it("keeps every refusal typed and never copies transport error text", () => {
    for (const reason of fleetEnrollRefusalSchema.options) {
      expect(fleetEnrollResultSchema.parse({ outcome: "refused", reason })).toEqual({ outcome: "refused", reason })
    }
    for (const reason of fleetForgetRefusalSchema.options) {
      expect(fleetForgetResultSchema.parse({ outcome: "refused", reason })).toEqual({ outcome: "refused", reason })
    }
    expect(fleetEnrollResultSchema.safeParse({ outcome: "refused", reason: "pairing-refused", message: "secret" }).success).toBe(false)
    expect(rpcMethods["device.revokeCurrent"].params.safeParse({ deviceId: "other-device" }).success).toBe(false)
  })
})

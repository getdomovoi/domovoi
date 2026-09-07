import { describe, expect, it } from "vitest"

import { devicePairParamsSchema } from "./devices.js"
import { rpcMethods, rpcMethodMutations } from "./rpc.js"

const machineId = `machine-${"a".repeat(32)}`
const deviceId = `device-${"b".repeat(32)}`

describe("remote client admission", () => {
  it("separates the authenticated issuer from the kind being granted", () => {
    const request = { label: "Laptop desktop", client: "cli", targetClient: "desktop" }
    expect(devicePairParamsSchema.parse(request)).toEqual(request)
    expect(devicePairParamsSchema.parse({ label: "Legacy caller", client: "cli" }))
      .toEqual({ label: "Legacy caller", client: "cli" })
    expect(devicePairParamsSchema.safeParse({ ...request, targetClient: "machine" }).success).toBe(false)
  })

  it("describes only the caller's authority without returning a credential", () => {
    const method = rpcMethods["device.current"]
    expect(method).toBeDefined()
    expect(method.params.parse({})).toEqual({})
    for (const result of [
      { kind: "daemon", machineId },
      { kind: "client", machineId, deviceId, client: "desktop" },
    ]) {
      expect(method.result.parse(result)).toEqual(result)
      expect(method.result.safeParse({ ...result, token: "n".repeat(43) }).success).toBe(false)
    }
    expect(method.result.safeParse({ kind: "client", machineId, client: "desktop" }).success).toBe(false)
    expect(rpcMethodMutations["device.current"]).toBe("read-only")
  })

  it("returns a resolved existing transport or a typed refusal, never a machine credential", () => {
    const method = rpcMethods["fleet.clientRoute"]
    expect(method).toBeDefined()
    expect(method.params.parse({ machineId })).toEqual({ machineId })
    const route = { outcome: "ready", machineId, transport: {
      kind: "wsl", endpoint: "ws://127.0.0.1:48731/rpc", authenticated: true,
    } }
    expect(method.result.parse(route)).toEqual(route)
    expect(method.result.safeParse({ ...route, credential: "n".repeat(43) }).success).toBe(false)
    expect(method.result.safeParse({ ...route, transport: { kind: "relay", endpoint: "wss://relay.invalid", authenticated: true } }).success).toBe(false)
    expect(method.result.parse({ outcome: "refused", reason: "client-route-unavailable" }))
      .toEqual({ outcome: "refused", reason: "client-route-unavailable" })
    expect(rpcMethodMutations["fleet.clientRoute"]).toBe("read-only")
  })
})

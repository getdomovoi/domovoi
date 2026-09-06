import { describe, expect, it } from "vitest"

import { deviceClaimResultSchema, deviceConfirmClaimParamsSchema, pendingDeviceClaimSchema, pairedDeviceSchema } from "./devices.js"
import { protocolVersion } from "./schema.js"
import { rpcMethods, rpcMethodMutations } from "./rpc.js"

const machineId = `machine-${"a".repeat(32)}`
const claim = { state: "pending", deviceId: `device-${"b".repeat(32)}`, machineId, expiresAt: "2026-09-05T12:05:00.000Z" }

describe("pending machine claims", () => {
  it("cannot describe pending authority as an active paired device", () => {
    expect(pendingDeviceClaimSchema.parse(claim)).toEqual(claim)
    expect(pairedDeviceSchema.safeParse(claim).success).toBe(false)
    expect(pendingDeviceClaimSchema.safeParse({ ...claim, token: "n".repeat(43) }).success).toBe(false)
  })

  it("returns only the pending capability and bounded target facts", () => {
    const result = { claim, token: "n".repeat(43), machine: {
      id: machineId, label: "studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
      capabilities: ["sessions"], transports: [],
    } }
    expect(deviceClaimResultSchema.parse(result)).toEqual(result)
    expect(deviceClaimResultSchema.safeParse({ ...result, sessions: [] }).success).toBe(false)
    expect(deviceClaimResultSchema.safeParse({ ...result, claim: { ...claim, expiresAt: undefined } }).success).toBe(false)
  })

  it("requires a versioned, source-bound confirmation and classifies it as a mutation", () => {
    const params = { authToken: "n".repeat(43), machineId, protocolVersion }
    expect(rpcMethods["device.confirmClaim"].params.parse(params)).toEqual(params)
    expect(rpcMethodMutations["device.confirmClaim"]).toBe("mutating")
    for (const key of Object.keys(params)) {
      expect(deviceConfirmClaimParamsSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([name]) => name !== key))).success).toBe(false)
    }
    expect(deviceConfirmClaimParamsSchema.safeParse({ ...params, client: "cli" }).success).toBe(false)
  })
})

import { describe, expect, it } from "vitest"

import { phoneAndTabletRpcMethods, rpcMethodAuthorizations, rpcMethodMutations, rpcMethods } from "./rpc.js"
import { tailnetListenerStatusSchema } from "./tailnet.js"

// TailnetReach (Q404 A): the daemon's own account of its tailnet listener, so
// the Settings card draws what the daemon is doing rather than what the
// switch last asked for.
describe("tailnet.status", () => {
  const expiresAt = "2026-12-20T04:12:00.000Z"

  it("is an observe method that changes nothing", () => {
    expect(rpcMethods["tailnet.status"].params.parse({})).toEqual({})
    expect(rpcMethods["tailnet.status"].params.safeParse({ address: "100.101.102.103" }).success).toBe(false)
    expect(rpcMethodAuthorizations["tailnet.status"]).toBe("observe")
    expect(rpcMethodMutations["tailnet.status"]).toBe("read-only")
    expect(rpcMethods["tailnet.status"].result).toBe(tailnetListenerStatusSchema)
  })

  it("stays off a phone or tablet credential, which has no tailnet setting to draw", () => {
    expect(phoneAndTabletRpcMethods.has("tailnet.status")).toBe(false)
  })

  it.each([
    { state: "off" },
    { state: "listening", address: "100.101.102.103", port: 47831, certificateExpiresAt: expiresAt },
    { state: "listening", address: "fd7a:115c:a1e0::1", port: 1, certificateExpiresAt: expiresAt },
    { state: "refused", address: "100.101.102.103", reason: "The tailnet certificate expired.", retrying: false, certificateExpiresAt: expiresAt },
    { state: "refused", address: "100.101.102.103", reason: "The tailnet address is not on this machine.", retrying: true },
  ])("accepts %j", (status) => {
    expect(tailnetListenerStatusSchema.parse(status)).toEqual(status)
  })

  it.each([
    { state: "on" },
    { state: "off", address: "100.101.102.103" },
    { state: "listening", address: "100.101.102.103", port: 47831 },
    { state: "listening", address: "100.101.102.103", port: 0, certificateExpiresAt: expiresAt },
    { state: "listening", address: "100.101.102.103", port: 65_536, certificateExpiresAt: expiresAt },
    { state: "listening", address: "100.101.102.103", port: 47831, certificateExpiresAt: "20 Dec 2026" },
    { state: "listening", address: "", port: 47831, certificateExpiresAt: expiresAt },
    { state: "listening", address: "a".repeat(46), port: 47831, certificateExpiresAt: expiresAt },
    { state: "listening", address: "100.101.102.103", port: 47831, certificateExpiresAt: expiresAt, key: "secret" },
    { state: "refused", address: "100.101.102.103", reason: " ", retrying: false },
    { state: "refused", address: "100.101.102.103", reason: "x".repeat(513), retrying: false },
    { state: "refused", address: "100.101.102.103", reason: "Refused." },
  ])("refuses %j", (status) => {
    expect(tailnetListenerStatusSchema.safeParse(status).success).toBe(false)
  })
})

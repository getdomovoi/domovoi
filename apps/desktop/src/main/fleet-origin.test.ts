import { describe, expect, it, vi } from "vitest"

import { FleetOriginAdmission } from "./fleet-origin.js"

const machineId = "machine-peer"
const route = { outcome: "ready" as const, machineId, transport: {
  kind: "lan" as const, endpoint: "wss://studio.example:47831/rpc", authenticated: true as const,
} }

describe("Desktop fleet origin admission", () => {
  it("does not let completed refusals exhaust admission for this window", async () => {
    const verify = vi.fn(async (id: string) => id === machineId ? route : { outcome: "refused" as const, reason: "not-enrolled" as const })
    const admission = new FleetOriginAdmission(verify, () => 0)
    for (let index = 0; index < 130; index += 1) {
      expect(await admission.authorize(`machine-missing-${index}`, 5_000)).toEqual({ outcome: "refused", reason: "not-enrolled" })
    }
    expect((await admission.authorize(machineId, 5_000)).outcome).toBe("ready")
  })

  it("bounds live checks without evicting another check and reclaims settled capacity", async () => {
    const finishers: Array<(value: typeof route) => void> = []
    const verify = vi.fn(() => new Promise<typeof route>(resolve => { finishers.push(resolve) }))
    const admission = new FleetOriginAdmission(verify, () => 0)
    const pending = Array.from({ length: 128 }, () => admission.authorize(machineId, 5_000))
    expect(await admission.authorize(machineId, 5_000)).toEqual({ outcome: "refused", reason: "client-route-unavailable" })
    expect(verify).toHaveBeenCalledTimes(128)
    for (const finish of finishers) finish(route)
    for (const result of await Promise.all(pending)) {
      if (result.outcome !== "ready") throw new Error("An active verification was evicted")
      expect(admission.consume(result.ticket)).toContain("wss://studio.example:47831")
    }
    verify.mockResolvedValue(route)
    expect((await admission.authorize(machineId, 5_000)).outcome).toBe("ready")
  })

  it("keeps a concurrent verification alive when its sibling refuses", async () => {
    let finish: (value: typeof route) => void = () => {}
    const verify = vi.fn().mockResolvedValueOnce({ outcome: "refused", reason: "not-enrolled" })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const admission = new FleetOriginAdmission(verify, () => 0)
    const first = admission.authorize(machineId, 5_000)
    const second = admission.authorize(machineId, 5_000)
    expect((await first).outcome).toBe("refused")
    finish(route)
    expect((await second).outcome).toBe("ready")
  })

  it("grants one origin only after the home daemon has verified it", async () => {
    let finish: (value: typeof route) => void = () => {}
    const verify = vi.fn(() => new Promise<typeof route>((resolve) => { finish = resolve }))
    const admission = new FleetOriginAdmission(verify)
    const pending = admission.authorize(machineId, 5_000)
    expect(admission.consume("invented")).toBe("default-src 'none'; connect-src 'none'")
    finish(route)
    const result = await pending
    expect(result.outcome).toBe("ready")
    if (result.outcome !== "ready") throw new Error("Expected verified route")
    const policy = admission.consume(result.ticket)
    expect(policy).toBe("default-src 'none'; connect-src wss://studio.example:47831")
    expect(policy).not.toContain("wss: ")
    expect(policy).not.toContain("*")
    expect(admission.consume(result.ticket)).toBe("default-src 'none'; connect-src 'none'")
  })

  it("refuses a wrong identity or refused route without issuing a ticket", async () => {
    const verify = vi.fn().mockResolvedValue({ outcome: "refused", reason: "not-enrolled" })
    const admission = new FleetOriginAdmission(verify)
    expect(await admission.authorize(machineId, 5_000)).toEqual({ outcome: "refused", reason: "not-enrolled" })
    verify.mockResolvedValue({ ...route, machineId: "machine-other" })
    expect(await admission.authorize(machineId, 5_000)).toEqual({ outcome: "refused", reason: "identity-mismatch" })
  })

  it("does not turn an expired verification or removed access into a grant", async () => {
    let now = 0
    let finish: (value: typeof route) => void = () => {}
    const admission = new FleetOriginAdmission(() => new Promise((resolve) => { finish = resolve }), () => now)
    const pending = admission.authorize(machineId, 50)
    now = 51
    finish(route)
    expect(await pending).toEqual({ outcome: "refused", reason: "route-timeout" })
    const removed = admission.authorize(machineId, 50)
    admission.forget(machineId)
    finish(route)
    expect(await removed).toEqual({ outcome: "refused", reason: "not-enrolled" })
  })

  it.each(["wss://*.example/rpc", "ws://studio.example/rpc", "wss://user:secret@studio.example/rpc", "wss://[2001:db8::1]/rpc"])(
    "refuses an origin CSP cannot name narrowly: %s", async (endpoint) => {
      const admission = new FleetOriginAdmission(async () => ({ ...route, transport: { ...route.transport, endpoint } }))
      expect(await admission.authorize(machineId, 5_000)).toEqual({ outcome: "refused", reason: "client-route-unavailable" })
    },
  )

  it("bounds ticket retention and invalidates unused tickets on removal", async () => {
    let now = 0
    const admission = new FleetOriginAdmission(async () => route, () => now)
    const first = await admission.authorize(machineId, 5_000)
    if (first.outcome !== "ready") throw new Error("Expected verified route")
    admission.forget(machineId)
    expect(admission.consume(first.ticket)).toContain("connect-src 'none'")
    const second = await admission.authorize(machineId, 5_000)
    if (second.outcome !== "ready") throw new Error("Expected verified route")
    now = 30_001
    expect(admission.consume(second.ticket)).toContain("connect-src 'none'")
  })
})

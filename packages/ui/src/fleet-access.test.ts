import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareFleetEndpoint } from "./fleet-access.js"
import { Deadline } from "./deadline.js"

afterEach(() => vi.useRealTimers())
const machineId = `machine-${"a".repeat(32)}`

describe("admitted client route", () => {
  it("uses the Desktop verifier, never a renderer-supplied origin or machine credential", async () => {
    const deadline = Deadline.start(1_000)
    const fleetRoute = vi.fn(async () => ({ outcome: "ready", machineId, ticket: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
      transport: { kind: "lan", endpoint: "wss://studio.example/rpc", authenticated: true } }))
    const homeRoute = vi.fn()
    try {
      const result = await prepareFleetEndpoint({ machineId, credential: "client-only", homeUrl: "ws://localhost:47831/rpc",
        kind: "desktop", route: homeRoute, bridge: { fleetRoute }, deadline })
      expect(homeRoute).not.toHaveBeenCalled()
      expect(fleetRoute).toHaveBeenCalledWith(machineId, expect.any(Number))
      expect(result.url).toBe("wss://studio.example/rpc")
      expect(result.token).toBe("client-only")
      expect(result.createSocket).toBeTypeOf("function")
    } finally { deadline.clear() }
  })

  it("does not borrow source-local routing from an off-host browser", async () => {
    const deadline = Deadline.start(1_000)
    const route = vi.fn(async () => ({ outcome: "refused" as const, reason: "client-route-unavailable" as const }))
    try {
      await expect(prepareFleetEndpoint({ machineId, credential: "client-only", homeUrl: "wss://home.example/rpc",
        kind: "web", route, deadline })).rejects.toMatchObject({ reason: "client-route-unavailable" })
      expect(route).toHaveBeenCalledWith({ machineId, allowSourceLocal: false }, { deadline })
    } finally { deadline.clear() }
  })

  it("refuses a late bridge answer within the caller's original deadline", async () => {
    vi.useFakeTimers()
    const deadline = Deadline.start(50)
    const pending = prepareFleetEndpoint({ machineId, credential: "client-only", homeUrl: "ws://localhost/rpc",
      kind: "desktop", route: vi.fn(), bridge: { fleetRoute: () => new Promise(() => {}) }, deadline })
    const rejected = expect(pending).rejects.toMatchObject({ reason: "route-timeout" })
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    deadline.clear()
  })
})

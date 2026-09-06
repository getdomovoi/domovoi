import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Deadline } from "@/deadline"

import type { DesktopStartup } from "./desktop-startup.js"
import { verifyLaunchSmokeDaemon } from "./launch-smoke.js"

const { construct } = vi.hoisted(() => ({ construct: vi.fn() }))
vi.mock("@/client", () => ({ DomovoiClient: construct }))

const startup = {
  kind: "workspace", daemon: { kind: "owned" },
  rpcUrl: "ws://127.0.0.1:41001/rpc", rpcToken: "root-smoke-token",
} satisfies DesktopStartup

function clients() {
  const workspace = { machine: { id: "machine-smoke" } }
  const device = { id: "device-smoke", lastSeenAt: "2026-09-05T10:00:00.000Z", revokedAt: "2026-09-05T10:00:01.000Z" }
  const pairing = { device, token: "paired-smoke-token" }
  const root = {
    connect: vi.fn(async (_deadline: Deadline) => workspace),
    request: vi.fn(async () => pairing),
    revokeDevice: vi.fn(async () => ({ device })),
    listDevices: vi.fn(async () => ({ devices: [device] })),
    disconnect: vi.fn(),
  }
  const paired = {
    connect: vi.fn(async (_deadline: Deadline) => workspace),
    request: vi.fn(async () => workspace),
    disconnect: vi.fn(),
  }
  construct.mockImplementationOnce(function () {
    // The total clock exists before either client can create a socket.
    expect(vi.getTimerCount()).toBe(1)
    return root
  }).mockImplementationOnce(function () { return paired })
  return { root, paired }
}

beforeEach(() => { vi.useFakeTimers(); construct.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe("renderer daemon smoke", () => {
  it("pairs, authenticates, reads and revokes with one total deadline", async () => {
    const { root, paired } = clients()
    await verifyLaunchSmokeDaemon(startup)
    const deadline = root.connect.mock.calls[0]?.[0]
    expect(deadline).toBeInstanceOf(Deadline)
    expect(deadline?.budgetMs).toBe(30_000)
    expect(construct.mock.calls).toEqual([
      [startup.rpcUrl, "desktop", { authToken: startup.rpcToken, budgets: { connectMs: 20_000, requestMs: 20_000 } }],
      [startup.rpcUrl, "desktop", { authToken: "paired-smoke-token", budgets: { connectMs: 20_000, requestMs: 20_000 } }],
    ])
    expect(root.request).toHaveBeenCalledWith("device.pair", { label: "Desktop launch smoke", client: "desktop" }, { deadline })
    expect(paired.connect).toHaveBeenCalledWith(deadline)
    expect(paired.request).toHaveBeenCalledWith("workspace.get", {}, { deadline })
    expect(root.revokeDevice).toHaveBeenCalledWith({ deviceId: "device-smoke" }, { deadline })
    expect(root.listDevices).toHaveBeenCalledWith({ deadline })
    expect(root.disconnect).toHaveBeenCalledOnce()
    expect(paired.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["connect", "request"] as const)("stops on root %s failure and clears its clock", async (method) => {
    const { root, paired } = clients()
    root[method].mockRejectedValueOnce(new Error("Root RPC failed"))
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("Root RPC failed")
    expect(construct).toHaveBeenCalledOnce()
    expect(root.disconnect).toHaveBeenCalledOnce()
    expect(paired.connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["connect", "request"] as const)("closes both clients after paired %s failure", async (method) => {
    const { root, paired } = clients()
    paired[method].mockRejectedValueOnce(new Error("Paired RPC failed"))
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("Paired RPC failed")
    expect(root.disconnect).toHaveBeenCalledOnce()
    expect(paired.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses to use a different daemon after pairing", async () => {
    const { paired } = clients()
    paired.connect.mockResolvedValueOnce({ machine: { id: "other-machine" } })
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("different daemon")
    expect(paired.request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("requires a persisted authenticated and revoked pairing", async () => {
    const { root } = clients()
    root.listDevices.mockResolvedValueOnce({ devices: [] })
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("not authenticated and revoked")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects late results even before the timer callback gets a turn", async () => {
    const { root } = clients()
    root.listDevices.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 30_001)
      return { devices: [{ id: "device-smoke", lastSeenAt: "seen", revokedAt: "revoked" }] }
    })
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("exceeded its deadline")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("names the step it was waiting on and what its budget had left", async () => {
    const { root } = clients()
    root.connect.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 20_000)
      throw new Error("Timed out after 20000ms during open of ws://127.0.0.1:41001/rpc")
    })
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow(
      "while opening the first connection to the daemon it started, 10000ms left of its 30000ms budget: "
      + "Timed out after 20000ms during open of ws://127.0.0.1:41001/rpc",
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps the cause of a named step reachable", async () => {
    const { root } = clients()
    const cause = new Error("Timed out after 20000ms during hello of ws://127.0.0.1:41001/rpc")
    root.request.mockRejectedValueOnce(cause)
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toMatchObject({ cause })
  })

  it.each([
    ["connect", "connecting as the paired device"],
    ["request", "reading the workspace as the paired device"],
  ] as const)("names the paired %s step", async (method, step) => {
    const { paired } = clients()
    paired[method].mockRejectedValueOnce(new Error("Paired RPC stalled"))
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow(`while ${step}, `)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the clock if client construction fails", async () => {
    construct.mockImplementationOnce(function () { throw new Error("Cannot create client") })
    await expect(verifyLaunchSmokeDaemon(startup)).rejects.toThrow("Cannot create client")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses an attached owner without opening any client", async () => {
    await expect(verifyLaunchSmokeDaemon({ ...startup, daemon: { kind: "attached", owner: "daemon" } }))
      .rejects.toThrow("must own its isolated daemon")
    expect(construct).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("surfaces acquisition refusal without opening any client", async () => {
    await expect(verifyLaunchSmokeDaemon({ kind: "refused", reason: "owner-unreachable", message: "No reachable owner" }))
      .rejects.toThrow("No reachable owner")
    expect(construct).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

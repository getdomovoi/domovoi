import type { DaemonServiceOutcome, DaemonServiceStatusReport } from "@getdomovoi/ui"
import { describe, expect, it, vi } from "vitest"

import { desktopFirstRunService } from "./first-run-service.js"

function bridge(install: () => Promise<DaemonServiceOutcome>, status: () => Promise<DaemonServiceStatusReport>) {
  return { platform: "darwin" as const, daemonService: { install, status, remove: vi.fn(), update: vi.fn() } }
}

describe("desktop first-run service", () => {
  it("offers nothing on a desktop that cannot install the service", () => {
    expect(desktopFirstRunService({ bridge: { platform: "darwin" }, owner: "app", onDaemonMoved: vi.fn() })).toBeUndefined()
  })

  // Setup installs through the same bridge as Settings. The window then
  // resolves its daemon again and carries the service as read back, so
  // Settings does not draw the service from a read taken before the install.
  it("installs, then hands the read-back service facts to the window that resolves its daemon again", async () => {
    const onDaemonMoved = vi.fn()
    const outcome: DaemonServiceOutcome = { ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.domovoid.plist", daemonRunning: true }
    const service = desktopFirstRunService({
      bridge: bridge(async () => outcome, async () => ({ installed: true, running: true, detail: "pid 48213" })),
      owner: "app",
      onDaemonMoved,
    })!
    expect(service).toMatchObject({ owner: "app", platform: "darwin" })
    expect(await service.install()).toBe(outcome)
    expect(onDaemonMoved).toHaveBeenCalledWith({ serviceInstalled: true, serviceRunning: true })
  })

  // Review P3-B: setup names the address of the daemon this window reached.
  it("carries the endpoint this window reached", () => {
    const service = desktopFirstRunService({
      bridge: bridge(vi.fn(), vi.fn()),
      owner: "app",
      endpoint: "ws://127.0.0.1:52101/rpc",
      onDaemonMoved: vi.fn(),
    })
    expect(service?.endpoint).toBe("ws://127.0.0.1:52101/rpc")
  })

  it("leaves the window alone after an install that moved nothing", async () => {
    const onDaemonMoved = vi.fn()
    const service = desktopFirstRunService({
      bridge: bridge(async () => ({ ok: false, reason: "refused", message: "1 turn is running." }), async () => ({ installed: false, running: false, detail: "" })),
      owner: "app",
      onDaemonMoved,
    })!
    await service.install()
    // A failure that only stopped this app's daemon keeps the window; its
    // line says to quit and reopen.
    const stopped = desktopFirstRunService({
      bridge: bridge(async () => ({ ok: false, reason: "failed", message: "launchctl exited 5", daemon: "stopped", service: { installed: false, running: false } }), async () => ({ installed: false, running: false, detail: "" })),
      owner: "app",
      onDaemonMoved,
    })!
    await stopped.install()
    expect(onDaemonMoved).not.toHaveBeenCalled()
  })

  it("resolves the daemon again when an unreadable answer follows an install the read-back shows", async () => {
    const onDaemonMoved = vi.fn()
    const service = desktopFirstRunService({
      bridge: bridge(async () => { throw new Error("Desktop returned an invalid service outcome") }, async () => ({ installed: true, running: false, detail: "" })),
      owner: "app",
      onDaemonMoved,
    })!
    await expect(service.install()).rejects.toThrow("Desktop returned an invalid service outcome")
    expect(onDaemonMoved).toHaveBeenCalledWith({ serviceInstalled: true, serviceRunning: false })
  })

  it("carries no facts it could not read", async () => {
    const onDaemonMoved = vi.fn()
    const service = desktopFirstRunService({
      bridge: bridge(async () => ({ ok: true, kind: "file", target: "/p", daemonRunning: true }), async () => ({ unavailable: "launchctl could not be run" })),
      owner: "app",
      onDaemonMoved,
    })!
    await service.install()
    expect(onDaemonMoved).toHaveBeenCalledWith({})
  })
})

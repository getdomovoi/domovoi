import { DaemonServiceRuntimeMissingError, type DaemonServiceInstallResult } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonService, daemonRuntimeLayout, profileRuntimeDirectory } from "./daemon-service.js"

const runtime = { nodePath: "/Users/dana/.domovoi/runtime/0.9.4/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/0.9.4/daemon/dist/index.js" }
const attachedToService = { kind: "attached" as const, owner: "daemon" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }

function harness(overrides: Partial<ConstructorParameters<typeof DesktopDaemonService>[0]> = {}) {
  const calls: string[] = []
  const deps = {
    stageRuntime: vi.fn(async () => { calls.push("stage"); return runtime }),
    install: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { calls.push("checks"); await options.releaseInAppDaemon?.(); calls.push("install"); return { kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" } }),
    status: vi.fn(async () => ({ installed: true, running: true, detail: "pid 48213" })),
    remove: vi.fn(async () => ({ kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", profileRecovery: "not-needed" as const })),
    daemon: {
      stopOwned: vi.fn(async () => { calls.push("stop") }),
      attachOnly: vi.fn(async () => { calls.push("attach"); return attachedToService }),
      restart: vi.fn(async () => { calls.push("restart"); return { kind: "owned" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" } }),
    },
    ...overrides,
  }
  return { service: new DesktopDaemonService(deps), deps, calls }
}

describe("DesktopDaemonService", () => {
  it("stages the runtime, lets the installer stop the in-app daemon after its checks, then attaches to the service", async () => {
    const { service, deps, calls } = harness()
    await expect(service.install()).resolves.toEqual({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" })
    expect(deps.install).toHaveBeenCalledWith(expect.objectContaining({ runtime }))
    expect(calls).toEqual(["stage", "checks", "stop", "install", "attach"])
  })

  it("reports a missing runtime without stopping anything", async () => {
    const { service, deps, calls } = harness({ stageRuntime: vi.fn(async () => { throw new DaemonServiceRuntimeMissingError("node", "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node", "missing") }) })
    const outcome = await service.install()
    expect(outcome).toMatchObject({ ok: false, reason: "runtime-missing", part: "node", path: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node" })
    expect(deps.daemon.stopOwned).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("starts its own daemon again when the install fails after the stop, and says so", async () => {
    const { service, calls } = harness({ install: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { await options.releaseInAppDaemon?.(); throw new Error("launchctl bootstrap exited 5") }) })
    await expect(service.install()).resolves.toMatchObject({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", restarted: true })
    expect(calls).toEqual(["stage", "stop", "restart"])
  })

  it("refuses a second install while one runs", async () => {
    let release!: () => void
    const { service } = harness({ install: vi.fn(() => new Promise<DaemonServiceInstallResult>((resolve) => { release = () => resolve({ kind: "file", path: "/p", configurationPath: "/c" }) })) })
    const first = service.install()
    await expect(service.install()).resolves.toMatchObject({ ok: false, reason: "busy" })
    release()
    await first
  })

  it("removes the service and starts the app's own daemon again", async () => {
    const { service, calls } = harness()
    await expect(service.remove()).resolves.toMatchObject({ ok: true, kind: "file", profileRecovery: "not-needed" })
    expect(calls).toEqual(["restart"])
  })

  it("reads the service status and reports an unreadable one as such", async () => {
    const { service } = harness()
    await expect(service.status()).resolves.toEqual({ installed: true, running: true, detail: "pid 48213" })
    const broken = harness({ status: vi.fn(async () => { throw new Error("launchctl could not be run") }) })
    await expect(broken.service.status()).resolves.toEqual({ unavailable: "launchctl could not be run" })
  })
})

describe("daemon runtime layout", () => {
  it("names the shipped runtime under the app's resources and its copy under the profile", () => {
    expect(daemonRuntimeLayout("/Applications/Domovoi.app/Contents/Resources", "darwin")).toEqual({
      nodePath: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node",
      daemonEntryPath: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/daemon/dist/index.js",
    })
    expect(daemonRuntimeLayout("C:\\Program Files\\Domovoi\\resources", "win32")).toEqual({
      nodePath: "C:\\Program Files\\Domovoi\\resources\\daemon-runtime\\node\\node.exe",
      daemonEntryPath: "C:\\Program Files\\Domovoi\\resources\\daemon-runtime\\daemon\\dist\\index.js",
    })
    expect(profileRuntimeDirectory("/Users/dana", "0.9.4", "darwin")).toBe("/Users/dana/.domovoi/runtime/0.9.4")
  })
})

describe("staging the shipped runtime under the profile", () => {
  it("copies node and the daemon from the app's resources and names the copy", async () => {
    const { stageDaemonRuntime } = await import("./daemon-service.js")
    const copied: [string, string][] = []
    const runtime = await stageDaemonRuntime({
      resourcesPath: "/Applications/Domovoi.app/Contents/Resources", home: "/Users/dana", version: "0.9.4", platform: "darwin",
      exists: async () => true,
      copy: async (from, to) => { copied.push([from, to]) },
    })
    expect(copied).toEqual([["/Applications/Domovoi.app/Contents/Resources/daemon-runtime", "/Users/dana/.domovoi/runtime/0.9.4"]])
    expect(runtime).toEqual({ nodePath: "/Users/dana/.domovoi/runtime/0.9.4/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/0.9.4/daemon/dist/index.js" })
  })

  it("names the missing shipped part before copying anything", async () => {
    const { stageDaemonRuntime } = await import("./daemon-service.js")
    const copy = vi.fn(async () => {})
    await expect(stageDaemonRuntime({
      resourcesPath: "/Applications/Domovoi.app/Contents/Resources", home: "/Users/dana", version: "0.9.4", platform: "darwin",
      exists: async (path) => !path.endsWith("bin/node"), copy,
    })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node", path: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node" })
    expect(copy).not.toHaveBeenCalled()
  })
})

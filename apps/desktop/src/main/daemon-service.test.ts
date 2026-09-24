import { DaemonServiceRuntimeMissingError, type AcquireLocalDaemonOptions, type DaemonServiceInstallResult, type LocalDaemonHandle } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonService, daemonRuntimeLayout, profileRuntimeDirectory } from "./daemon-service.js"
import { DesktopDaemon } from "./desktop-daemon.js"

const runtime = { nodePath: "/Users/dana/.domovoi/runtime/0.9.4/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/0.9.4/daemon/dist/index.js" }
const attachedToService = { kind: "attached" as const, owner: "daemon" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }

function harness(overrides: Partial<ConstructorParameters<typeof DesktopDaemonService>[0]> = {}) {
  const calls: string[] = []
  const deps = {
    stageRuntime: vi.fn(async () => { calls.push("stage"); return runtime }),
    install: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { calls.push("checks"); await options.releaseInAppDaemon?.(); calls.push("install"); return { kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" } }),
    status: vi.fn(async () => ({ installed: true, running: true, detail: "pid 48213" })),
    refusal: vi.fn(async (): Promise<string | undefined> => undefined),
    remove: vi.fn(async () => ({ kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", profileRecovery: "not-needed" as const })),
    daemon: {
      beginHandoff: vi.fn(() => { calls.push("hold") }),
      endHandoff: vi.fn(() => { calls.push("release") }),
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
    await expect(service.install()).resolves.toEqual({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json", daemonRunning: true })
    expect(deps.install).toHaveBeenCalledWith(expect.objectContaining({ runtime }))
    expect(calls).toEqual(["stage", "checks", "hold", "stop", "install", "attach", "release"])
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
    await expect(service.install()).resolves.toMatchObject({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "restarted" })
    expect(calls).toEqual(["stage", "hold", "stop", "restart", "release"])
  })

  it("says the daemon is stopped when the install fails after the stop and the restart does not come back", async () => {
    const failing = vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { await options.releaseInAppDaemon?.(); throw new Error("launchctl bootstrap exited 5") })
    const refusedRestart = harness({ install: failing })
    vi.mocked(refusedRestart.deps.daemon.restart).mockImplementationOnce(async () => ({ kind: "refused", reason: "owner-unreachable", message: "no daemon" }) as never)
    await expect(refusedRestart.service.install()).resolves.toMatchObject({ ok: false, reason: "failed", daemon: "stopped" })
    const thrownRestart = harness({ install: failing })
    vi.mocked(thrownRestart.deps.daemon.restart).mockImplementationOnce(async () => { throw new Error("Desktop is quitting") })
    await expect(thrownRestart.service.install()).resolves.toMatchObject({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped" })
    expect(thrownRestart.calls.at(-1)).toBe("release")
  })

  it("says the daemon was not touched when the install fails before the stop", async () => {
    const { service, calls } = harness({ install: vi.fn(async () => { throw new Error("launchctl is not available") }) })
    await expect(service.install()).resolves.toMatchObject({ ok: false, reason: "failed", daemon: "untouched" })
    expect(calls).toEqual(["stage"])
  })

  it("reports an installed service this app could not attach to as installed, and does not restart its own daemon", async () => {
    const refusedAttach = harness()
    vi.mocked(refusedAttach.deps.daemon.attachOnly).mockImplementationOnce(async () => ({ kind: "refused", reason: "owner-unreachable", message: "The daemon did not answer" }) as never)
    await expect(refusedAttach.service.install()).resolves.toEqual({
      ok: false, reason: "installed-not-attached", kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", message: "The daemon did not answer",
    })
    expect(refusedAttach.deps.daemon.restart).not.toHaveBeenCalled()
    const thrownAttach = harness()
    vi.mocked(thrownAttach.deps.daemon.attachOnly).mockImplementationOnce(async () => { throw new Error("attach timed out") })
    await expect(thrownAttach.service.install()).resolves.toMatchObject({ ok: false, reason: "installed-not-attached", message: "attach timed out" })
    expect(thrownAttach.deps.daemon.restart).not.toHaveBeenCalled()
    expect(thrownAttach.calls.at(-1)).toBe("release")
  })

  it("refuses to install or remove while the daemon's own workspace has a turn running or a gate waiting, before touching anything", async () => {
    const { service, deps, calls } = harness({ refusal: vi.fn(async () => "1 turn is running (Fix login).") })
    await expect(service.install()).resolves.toEqual({ ok: false, reason: "refused", message: "1 turn is running (Fix login)." })
    await expect(service.remove()).resolves.toEqual({ ok: false, reason: "refused", message: "1 turn is running (Fix login)." })
    expect(calls).toEqual([])
    expect(deps.install).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it("refuses when the daemon's workspace cannot be read, since not knowing is not a yes", async () => {
    const { service, calls } = harness({ refusal: vi.fn(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:47831") }) })
    await expect(service.install()).resolves.toEqual({ ok: false, reason: "check-failed", message: "connect ECONNREFUSED 127.0.0.1:47831" })
    await expect(service.remove()).resolves.toEqual({ ok: false, reason: "check-failed", message: "connect ECONNREFUSED 127.0.0.1:47831" })
    expect(calls).toEqual([])
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
    await expect(service.remove()).resolves.toMatchObject({ ok: true, kind: "file", profileRecovery: "not-needed", daemonRunning: true })
    expect(calls).toEqual(["hold", "restart", "release"])
  })

  it("carries the removal's profile recovery and says when the app's own daemon did not come back", async () => {
    const { service, deps } = harness({ remove: vi.fn(async () => ({ kind: "task" as const, name: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable" as const, profileRecoveryDetail: "The service record could not be read" })) })
    vi.mocked(deps.daemon.restart).mockImplementationOnce(async () => ({ kind: "refused", reason: "owner-unreachable", message: "no daemon" }) as never)
    await expect(service.remove()).resolves.toEqual({
      ok: true, kind: "task", target: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable", profileRecoveryDetail: "The service record could not be read", daemonRunning: false,
    })
    vi.mocked(deps.daemon.restart).mockImplementationOnce(async () => { throw new Error("Desktop is quitting") })
    await expect(service.remove()).resolves.toMatchObject({ ok: true, daemonRunning: false })
  })

  it("reads the service status and reports an unreadable one as such", async () => {
    const { service } = harness()
    await expect(service.status()).resolves.toEqual({ installed: true, running: true, detail: "pid 48213" })
    const broken = harness({ status: vi.fn(async () => { throw new Error("launchctl could not be run") }) })
    await expect(broken.service.status()).resolves.toEqual({ unavailable: "launchctl could not be run" })
  })
})

// The race the order test above cannot see: the stop drops the renderer's
// socket, and the renderer reconnects while the installer still holds the
// profile. The real DesktopDaemon with a scripted seam shows what that
// reconnect asks for.
describe("a renderer reconnect during the handoff", () => {
  it("never starts an in-app daemon mid-install, and gets the service's endpoint once it is attached", async () => {
    const modes: AcquireLocalDaemonOptions["mode"][] = []
    const handles: LocalDaemonHandle[] = [
      { kind: "owned", endpoint: { url: "ws://127.0.0.1:47831/rpc", token: "app" }, stop: vi.fn(async () => {}) },
      { kind: "attached", owner: "daemon", endpoint: { url: "ws://127.0.0.1:47831/rpc", token: "service" }, closed: new Promise(() => {}), detach: vi.fn() },
    ]
    const daemon = new DesktopDaemon(vi.fn(async (options: AcquireLocalDaemonOptions) => {
      modes.push(options.mode)
      const next = handles.shift()
      if (!next) throw new Error("No handle was scripted for this acquisition")
      return next
    }), () => ({ environment: {}, homeDirectory: "/Users/dana", machineLabel: "mac", errorSink: () => {} }))
    await daemon.acquire()
    let reconnect: Promise<unknown> | undefined
    const service = new DesktopDaemonService({
      stageRuntime: async () => runtime,
      install: async (options) => {
        await options.releaseInAppDaemon?.()
        reconnect = daemon.reacquire()
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
        return { kind: "file", path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" }
      },
      status: async () => ({ installed: true, running: true, detail: "" }),
      remove: async () => ({ kind: "file", path: "/p", profileRecovery: "not-needed" }),
      refusal: async () => undefined,
      daemon,
    })
    const outcome = await service.install()
    expect(modes).toEqual(["start-or-attach", "attach-only"])
    expect(outcome).toMatchObject({ ok: true })
    await expect(reconnect).resolves.toMatchObject({ kind: "attached", token: "service" })
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
      remove: async () => {},
      rename: async (from, to) => { copied.push([from, to]) },
    })
    expect(copied).toEqual([
      ["/Applications/Domovoi.app/Contents/Resources/daemon-runtime", expect.stringMatching(/^\/Users\/dana\/\.domovoi\/runtime\/\.0\.9\.4\.staging-/)],
      [expect.stringMatching(/^\/Users\/dana\/\.domovoi\/runtime\/\.0\.9\.4\.staging-/), "/Users/dana/.domovoi/runtime/0.9.4"],
    ])
    expect(runtime).toEqual({ nodePath: "/Users/dana/.domovoi/runtime/0.9.4/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/0.9.4/daemon/dist/index.js" })
  })

  it("replaces an earlier copy of the same version whole, so no stale file survives, and leaves no staging directory", async () => {
    const { stageDaemonRuntime } = await import("./daemon-service.js")
    const { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile, access } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const root = await mkdtemp(join(tmpdir(), "domovoi-stage-"))
    try {
      const resources = join(root, "Resources")
      await mkdir(join(resources, "daemon-runtime", "node", "bin"), { recursive: true })
      await mkdir(join(resources, "daemon-runtime", "daemon", "dist"), { recursive: true })
      await writeFile(join(resources, "daemon-runtime", "node", "bin", "node"), "node")
      await writeFile(join(resources, "daemon-runtime", "daemon", "dist", "index.js"), "daemon")
      const home = join(root, "home")
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "stale-chunk.js"), "old")
      const fileSystem = {
        exists: async (path: string) => { try { await access(path); return true } catch { return false } },
        copy: (from: string, to: string) => cp(from, to, { recursive: true, force: true }),
        remove: (path: string) => rm(path, { recursive: true, force: true }),
        rename: (from: string, to: string) => rename(from, to),
      }
      await stageDaemonRuntime({ resourcesPath: resources, home, version: "0.9.4", platform: "linux", ...fileSystem })
      expect((await readdir(join(earlier, "daemon", "dist"))).sort()).toEqual(["index.js"])
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])

      await writeFile(join(earlier, "daemon", "dist", "stale-chunk.js"), "old")
      await expect(stageDaemonRuntime({ resourcesPath: resources, home, version: "0.9.4", platform: "linux", ...fileSystem,
        copy: async () => { throw new Error("disk full") } })).rejects.toThrow("disk full")
      expect((await readdir(join(earlier, "daemon", "dist"))).sort()).toEqual(["index.js", "stale-chunk.js"])
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("names the missing shipped part before copying anything", async () => {
    const { stageDaemonRuntime } = await import("./daemon-service.js")
    const copy = vi.fn(async () => {})
    await expect(stageDaemonRuntime({
      resourcesPath: "/Applications/Domovoi.app/Contents/Resources", home: "/Users/dana", version: "0.9.4", platform: "darwin",
      exists: async (path) => !path.endsWith("bin/node"), copy, remove: async () => {}, rename: async () => {},
    })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node", path: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node" })
    expect(copy).not.toHaveBeenCalled()
  })
})

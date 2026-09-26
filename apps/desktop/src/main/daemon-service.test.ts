import { DaemonServiceRuntimeMissingError, type AcquireLocalDaemonOptions, type DaemonServiceInstallResult, type LocalDaemonHandle } from "@getdomovoi/daemon"
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonService, daemonRuntimeLayout, nodeRuntimeFileSystem, profileRuntimeDirectory, stageDaemonRuntime, type RuntimeFileSystem } from "./daemon-service.js"
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
    fence: vi.fn(async (): Promise<{ refusal: string } | { release: () => void }> => { calls.push("fence"); return { release: () => { calls.push("unfence") } } }),
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
    expect(calls).toEqual(["stage", "checks", "fence", "hold", "stop", "install", "attach", "unfence", "release"])
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
    expect(calls).toEqual(["stage", "fence", "hold", "stop", "restart", "unfence", "release"])
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
    expect(calls).toEqual(["fence", "hold", "restart", "unfence", "release"])
  })

  it("carries the removal's profile recovery and says when the app's own daemon did not come back", async () => {
    const { service, deps } = harness({ remove: vi.fn(async () => ({ kind: "task" as const, name: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable" as const, profileRecoveryDetail: "The service record could not be read" })) })
    vi.mocked(deps.daemon.restart).mockImplementationOnce(async () => ({ kind: "refused", reason: "owner-unreachable", message: "no daemon" }) as never)
    await expect(service.remove()).resolves.toEqual({
      ok: true, kind: "task", target: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable", profileRecoveryDetail: "The service record could not be read", daemonRunning: false, daemonAttached: false,
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

// Security review round 1 of #576. The first workspace read is only a snapshot:
// a turn can start between it and the stop. The daemon's own fence closes that
// gap, and each outcome says what is still true after a partial change.
describe("DesktopDaemonService after security review round 1", () => {
  it("takes the daemon's fence right before the stop, and refuses without stopping when a turn started after the first check", async () => {
    const { service, deps, calls } = harness()
    vi.mocked(deps.fence).mockImplementationOnce(async () => ({ refusal: "1 turn is running (Fix login)." }))
    await expect(service.install()).resolves.toEqual({ ok: false, reason: "refused", message: "1 turn is running (Fix login)." })
    expect(deps.daemon.stopOwned).not.toHaveBeenCalled()
    expect(deps.daemon.beginHandoff).not.toHaveBeenCalled()
    expect(calls).toEqual(["stage", "checks"])

    vi.mocked(deps.fence).mockImplementationOnce(async () => ({ refusal: "1 gate is waiting (Fix login)." }))
    await expect(service.remove()).resolves.toEqual({ ok: false, reason: "refused", message: "1 gate is waiting (Fix login)." })
    expect(deps.remove).not.toHaveBeenCalled()
    expect(deps.daemon.restart).not.toHaveBeenCalled()
  })

  it("waits when the daemon's fence cannot be taken, and stops nothing", async () => {
    const { service, deps } = harness()
    vi.mocked(deps.fence).mockImplementationOnce(async () => { throw new Error("The daemon closed the connection") })
    await expect(service.install()).resolves.toEqual({ ok: false, reason: "check-failed", message: "The daemon closed the connection" })
    vi.mocked(deps.fence).mockImplementationOnce(async () => { throw new Error("The daemon closed the connection") })
    await expect(service.remove()).resolves.toEqual({ ok: false, reason: "check-failed", message: "The daemon closed the connection" })
    expect(deps.daemon.stopOwned).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it("reports a daemon it attached to after a removal as running, and as one this app did not start", async () => {
    const { service, deps } = harness()
    vi.mocked(deps.daemon.restart).mockImplementationOnce(async () => attachedToService)
    await expect(service.remove()).resolves.toMatchObject({ ok: true, daemonRunning: true, daemonAttached: true })
    vi.mocked(deps.daemon.restart).mockImplementationOnce(async () => ({ kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t" }))
    await expect(service.remove()).resolves.toMatchObject({ ok: true, daemonRunning: true, daemonAttached: false })
  })

  it("reads the service back after a failed install, so a service the manager left behind is not called nothing", async () => {
    const failing = vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { await options.releaseInAppDaemon?.(); throw new Error("launchctl bootstrap exited 5") })
    const left = harness({ install: failing, status: vi.fn(async () => ({ installed: true, running: false, detail: "not loaded" })) })
    await expect(left.service.install()).resolves.toEqual({ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "restarted", service: { installed: true, running: false } })
    const unreadable = harness({ install: failing, status: vi.fn(async () => { throw new Error("launchctl could not be run") }) })
    await expect(unreadable.service.install()).resolves.toMatchObject({ ok: false, reason: "failed", service: null })
    const attached = harness({ install: failing, status: vi.fn(async () => ({ installed: false, running: false, detail: "" })) })
    vi.mocked(attached.deps.daemon.restart).mockImplementationOnce(async () => attachedToService)
    await expect(attached.service.install()).resolves.toMatchObject({ ok: false, reason: "failed", daemon: "attached", service: { installed: false, running: false } })
  })

  it("reads the service back after a failed removal, and takes a daemon back when the service no longer runs", async () => {
    const partial = harness({
      remove: vi.fn(async () => { throw new Error("unlink ~/Library/LaunchAgents/sh.domovoi.daemon.plist: permission denied") }),
      status: vi.fn(async () => ({ installed: true, running: false, detail: "not loaded" })),
    })
    await expect(partial.service.remove()).resolves.toEqual({
      ok: false, reason: "failed", message: "unlink ~/Library/LaunchAgents/sh.domovoi.daemon.plist: permission denied", daemon: "restarted", service: { installed: true, running: false },
    })
    expect(partial.calls).toEqual(["fence", "hold", "restart", "unfence", "release"])

    const untouched = harness({
      remove: vi.fn(async () => { throw new Error("launchctl bootout exited 5") }),
      status: vi.fn(async () => ({ installed: true, running: true, detail: "pid 48213" })),
    })
    await expect(untouched.service.remove()).resolves.toEqual({
      ok: false, reason: "failed", message: "launchctl bootout exited 5", daemon: "untouched", service: { installed: true, running: true },
    })
    expect(untouched.deps.daemon.restart).not.toHaveBeenCalled()
  })
})

// Security review round 9 of #576: reaching a daemon after the install is
// not proof the service took over. Another app's daemon, or one started by
// hand while the service is stopped, answers the attach just as well. The
// install reports success only when the attached daemon is the one a daemon
// outside any app runs and the service reads back installed and running.
describe("DesktopDaemonService install, round 9", () => {
  it("reports success only when the attached daemon is the running service's", async () => {
    const ok = harness()
    await expect(ok.service.install()).resolves.toMatchObject({ ok: true })

    for (const [label, attach, status] of [
      ["another app's daemon", { kind: "attached", owner: "desktop", url: "ws://127.0.0.1:47831/rpc", token: "t" }, { installed: true, running: true, detail: "" }],
      ["a stopped service", attachedToService, { installed: true, running: false, detail: "not loaded" }],
      ["a service that reads back not installed", attachedToService, { installed: false, running: false, detail: "" }],
      ["a service whose state is unknown", attachedToService, { installed: null, running: false, detail: "" }],
    ] as const) {
      const partial = harness({ status: vi.fn(async () => status) })
      vi.mocked(partial.deps.daemon.attachOnly).mockImplementationOnce(async () => attach as never)
      const outcome = await partial.service.install()
      expect(outcome, label).toMatchObject({ ok: false, reason: "installed-not-attached", kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist" })
      expect(partial.deps.daemon.restart, label).not.toHaveBeenCalled()
    }

    const unreadable = harness({ status: vi.fn(async () => { throw new Error("launchctl could not be run") }) })
    await expect(unreadable.service.install()).resolves.toMatchObject({ ok: false, reason: "installed-not-attached" })
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
      fence: async () => ({ release: () => {} }),
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
    await withScratch(async ({ resources, home }) => {
      const renamed: [string, string][] = []
      const runtime = await stage({ resources, home, version: "0.9.4", rename: async (from, to) => { renamed.push([from, to]); await rename(from, to) } })
      const destination = join(home, ".domovoi", "runtime", "0.9.4")
      expect(renamed).toEqual([[expect.stringContaining(join(home, ".domovoi", "runtime", ".0.9.4.staging-")), destination]])
      expect(runtime).toEqual(daemonRuntimeLayoutUnder(destination))
      expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
      expect(await readFile(runtime.nodePath, "utf8")).toBe("node")
    })
  })

  it("replaces an earlier copy of the same version whole, so no stale file survives, and leaves no staging directory", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "stale-chunk.js"), "old")
      await stage({ resources, home, version: "0.9.4" })
      expect((await readdir(join(earlier, "daemon", "dist"))).sort()).toEqual(["index.js"])
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])

      await writeFile(join(earlier, "daemon", "dist", "stale-chunk.js"), "old")
      await expect(stage({ resources, home, version: "0.9.4", copy: async () => { throw new Error("disk full") } })).rejects.toThrow("disk full")
      expect((await readdir(join(earlier, "daemon", "dist"))).sort()).toEqual(["index.js", "stale-chunk.js"])
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
  })

  it("refuses a version that is not one directory name, and replaces nothing outside the runtime directory", async () => {
    await withScratch(async ({ resources, home, root }) => {
      const victim = join(root, "victim")
      await mkdir(victim, { recursive: true })
      await writeFile(join(victim, "keep.txt"), "keep")
      for (const version of ["../../../victim", "..", "0.9.4/../../x", "0.9.4\\..\\x", ""]) {
        await expect(stage({ resources, home, version })).rejects.toThrow()
      }
      expect(await readdir(victim)).toEqual(["keep.txt"])
      expect(() => profileRuntimeDirectory(home, "../victim", "darwin")).toThrow()
    })
  })

  it("refuses a runtime directory reached through a link, and changes nothing where the link points", async () => {
    await withScratch(async ({ resources, home, root }) => {
      const elsewhere = join(root, "elsewhere")
      await mkdir(join(elsewhere, "0.9.4"), { recursive: true })
      await writeFile(join(elsewhere, "0.9.4", "keep.txt"), "keep")
      await mkdir(join(home, ".domovoi"), { recursive: true })
      await symlink(elsewhere, join(home, ".domovoi", "runtime"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await readdir(elsewhere)).toEqual(["0.9.4"])
      expect(await readdir(join(elsewhere, "0.9.4"))).toEqual(["keep.txt"])
    })
    await withScratch(async ({ resources, home, root }) => {
      const elsewhere = join(root, "elsewhere")
      await mkdir(join(elsewhere, "runtime", "0.9.4"), { recursive: true })
      await writeFile(join(elsewhere, "runtime", "0.9.4", "keep.txt"), "keep")
      await symlink(elsewhere, join(home, ".domovoi"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await readdir(join(elsewhere, "runtime", "0.9.4"))).toEqual(["keep.txt"])
    })
  })

  it("requires each shipped part to be a regular file and refuses a link that leaves the shipped runtime, before copying", async () => {
    await withScratch(async ({ resources, home }) => {
      const nodePath = daemonRuntimeLayout(resources, platform).nodePath
      await rm(nodePath)
      await mkdir(nodePath)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node" })
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home, root }) => {
      await writeFile(join(root, "outside.js"), "outside")
      await rm(join(resources, "daemon-runtime", "daemon", "dist", "index.js"))
      await symlink(join(root, "outside.js"), join(resources, "daemon-runtime", "daemon", "dist", "index.js"))
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "daemon" })
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home, root }) => {
      await mkdir(join(root, "outside"))
      await symlink(join(root, "outside"), join(resources, "daemon-runtime", "node", "lib"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home }) => {
      // A link that stays inside the shipped runtime, as npm's bin links do,
      // is kept as a link in the copy.
      await symlink("../daemon/dist/index.js", join(resources, "daemon-runtime", "node", "daemon-entry"), "file")
      const runtime = await stage({ resources, home, version: "0.9.4" })
      expect(runtime).toEqual(daemonRuntimeLayoutUnder(join(home, ".domovoi", "runtime", "0.9.4")))
      expect(await readlink(join(home, ".domovoi", "runtime", "0.9.4", "node", "daemon-entry"))).toBe("../daemon/dist/index.js")
    })
  })

  it("keeps the earlier copy of the same version when publishing the new one fails", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      await expect(stage({ resources, home, version: "0.9.4", rename: async (from, to) => {
        if (from.includes(".staging-")) throw new Error("rename failed")
        await rename(from, to)
      } })).rejects.toThrow("rename failed")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
  })

  // Security review round 2 of #576. A durable rename renames, then flushes
  // the directory, and the flush can throw after the move is done. The rule:
  // a staging that reports failure leaves the version path as it was before,
  // the earlier copy there or nothing there. What moved is read back from the
  // disk, not inferred from which call threw.
  const syncFailsAfter = (step: string) => async (from: string, to: string) => {
    await rename(from, to)
    if (from.includes(step) || to.includes(step)) throw new Error("simulated directory sync failure")
  }

  it("puts the earlier copy back when the flush after moving it aside fails", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".previous-") })).rejects.toThrow("simulated directory sync failure")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
  })

  it("does not leave the new copy published when the flush after publishing it fails", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".staging-") })).rejects.toThrow("simulated directory sync failure")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
    await withScratch(async ({ resources, home }) => {
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".staging-") })).rejects.toThrow("simulated directory sync failure")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual([])
    })
  })

  // Final review round 3 of #576. A recursive remove can fail part way, and a
  // failed read of the disk must not replace the error that stopped the
  // publish. The rule still holds: the earlier copy is at the version path, or
  // nothing is.
  const partialRemove = (runtimeRoot: string) => async (path: string) => {
    if (path.includes(".staging-") || !path.startsWith(runtimeRoot)) return rm(path, { recursive: true, force: true })
    await rm(join(path, "daemon", "dist", "index.js"), { force: true })
    throw new Error("simulated partial remove")
  }

  it("puts the earlier copy back when removing the new copy fails part way", async () => {
    await withScratch(async ({ resources, home }) => {
      const runtimeRoot = join(home, ".domovoi", "runtime")
      const earlier = join(runtimeRoot, "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".staging-"), remove: partialRemove(runtimeRoot) }))
        .rejects.toThrow("simulated directory sync failure")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect((await readdir(runtimeRoot)).filter((name) => !name.startsWith(".0.9.4.failed-"))).toEqual(["0.9.4"])
    })
  })

  it("leaves nothing at the version path when removing a new copy with no earlier one fails part way", async () => {
    await withScratch(async ({ resources, home }) => {
      const runtimeRoot = join(home, ".domovoi", "runtime")
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".staging-"), remove: partialRemove(runtimeRoot) }))
        .rejects.toThrow("simulated directory sync failure")
      expect((await readdir(runtimeRoot)).filter((name) => !name.startsWith(".0.9.4.failed-"))).toEqual([])
    })
  })

  it("keeps the error that stopped the publish when reading the disk back fails, and still puts the earlier copy back", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      const entry = nodeRuntimeFileSystem().entry
      await expect(stage({ resources, home, version: "0.9.4", rename: syncFailsAfter(".staging-"), entry: async (path) => {
        if (path.includes(".previous-")) throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" })
        return entry(path)
      } })).rejects.toThrow("simulated directory sync failure")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
  })

  // Final check on #576: removing the staging directory is cleanup. It must
  // not replace the error that stopped a publish, nor turn a completed publish
  // into a reported failure.
  const stagingRemoveFails = async (path: string) => {
    if (path.includes(".staging-")) throw new Error("simulated staging remove failure")
    await rm(path, { recursive: true, force: true })
  }

  it("reports a completed publish as done when removing the staging directory fails", async () => {
    await withScratch(async ({ resources, home }) => {
      const runtime = await stage({ resources, home, version: "0.9.4", remove: stagingRemoveFails })
      expect(runtime).toEqual(daemonRuntimeLayoutUnder(join(home, ".domovoi", "runtime", "0.9.4")))
      expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
    })
  })

  it("keeps the error that stopped the publish when removing the staging directory fails", async () => {
    await withScratch(async ({ resources, home }) => {
      await expect(stage({ resources, home, version: "0.9.4", remove: stagingRemoveFails, copy: async () => { throw new Error("disk full") } }))
        .rejects.toThrow("disk full")
    })
  })

  it("names the missing shipped part before copying anything", async () => {
    await withScratch(async ({ resources, home }) => {
      const nodePath = daemonRuntimeLayout(resources, platform).nodePath
      await rm(nodePath)
      const copy = vi.fn(async () => {})
      await expect(stage({ resources, home, version: "0.9.4", copy })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node", path: nodePath })
      expect(copy).not.toHaveBeenCalled()
    })
  })
})

const platform = process.platform === "win32" ? "win32" : "linux"
const directoryLink = process.platform === "win32" ? "junction" : "dir"

function daemonRuntimeLayoutUnder(destination: string) {
  return platform === "win32"
    ? { nodePath: join(destination, "node", "node.exe"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
    : { nodePath: join(destination, "node", "bin", "node"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
}

// Real files in a scratch directory: the shipped runtime under Resources and
// an empty home. Nothing here reaches the real profile.
async function withScratch(run: (paths: { root: string; resources: string; home: string }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-stage-")))
  try {
    const resources = join(root, "Resources")
    const shipped = daemonRuntimeLayout(resources, platform)
    await mkdir(dirname(shipped.nodePath), { recursive: true })
    await mkdir(dirname(shipped.daemonEntryPath), { recursive: true })
    await writeFile(shipped.nodePath, "node")
    await writeFile(shipped.daemonEntryPath, "daemon")
    const home = join(root, "home")
    await mkdir(home)
    await run({ root, resources, home })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).sort()
}

type StageInput = {
  resources: string
  home: string
  version: string
  copy?: (from: string, to: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  remove?: (path: string) => Promise<void>
  entry?: RuntimeFileSystem["entry"]
}

function stage(input: StageInput) {
  return stageDaemonRuntime({
    resourcesPath: input.resources, home: input.home, version: input.version, platform,
    fileSystem: nodeRuntimeFileSystem({
      ...(input.copy ? { copy: input.copy } : {}),
      ...(input.rename ? { rename: input.rename } : {}),
      ...(input.remove ? { remove: input.remove } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
    }),
  })
}

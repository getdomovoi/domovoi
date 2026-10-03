import { DaemonServiceRuntimeMissingError, DaemonServiceUpdateError, type AcquireLocalDaemonOptions, type DaemonServiceInstallResult, type LocalDaemonHandle } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonService } from "./daemon-service.js"
import { DesktopDaemon } from "./desktop-daemon.js"

const runtime = { nodePath: "/Users/dana/.domovoi/runtime/0.9.4/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/0.9.4/daemon/dist/index.js" }
// Round 4 (P2): the service calls publish the staged runtime under their
// lease; this side never does. Round 7: preparing writes nothing, so there
// is nothing to discard. The spies are separate from the call order above.
const stagedRuntime = { nodePath: "/Users/dana/.domovoi/runtime/.0.9.4.staging-1/node/bin/node", daemonEntryPath: "/Users/dana/.domovoi/runtime/.0.9.4.staging-1/daemon/dist/index.js" }
function staged() {
  return { runtime, staged: stagedRuntime, publish: vi.fn(async () => {}) }
}
const attachedToService = { kind: "attached" as const, owner: "daemon" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }
// #635: the copy the service ran before this change.
const previousCopy = "/Users/dana/.domovoi/runtime/0.9.3/0123456789ab"

function harness(overrides: Partial<ConstructorParameters<typeof DesktopDaemonService>[0]> = {}) {
  const calls: string[] = []
  const deps = {
    stageRuntime: vi.fn(async () => { calls.push("stage"); return staged() }),
    install: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { calls.push("checks"); await options.releaseInAppDaemon?.(); calls.push("install"); return { kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" } }),
    status: vi.fn(async () => ({ installed: true, running: true, detail: "pid 48213" })),
    profile: vi.fn(async (): Promise<{ app: string; service: string } | undefined> => undefined),
    refusal: vi.fn(async (): Promise<string | undefined> => undefined),
    fence: vi.fn(async (): Promise<{ refusal: string } | { release: () => void }> => { calls.push("fence"); return { release: () => { calls.push("unfence") } } }),
    remove: vi.fn(async () => ({ kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", profileRecovery: "not-needed" as const })),
    update: vi.fn(async () => { calls.push("update"); return { kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" } }),
    runtimeCopy: vi.fn(async (): Promise<{ installed: false } | { installed: true; copy?: string }> => { calls.push("read service copy"); return { installed: true, copy: previousCopy } }),
    removeUnusedRuntimes: vi.fn(async () => { calls.push("remove unused copies") }),
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

// Security review round 4 of #577 (P2): the staged copy stays inert. The
// service calls get it with a publish step they run under their lease, after
// the profile check; this side never publishes, and discards what was not.
describe("DesktopDaemonService hands over an inert staged runtime", () => {
  it("passes the staged runtime and its publish step to install and update, and publishes nothing itself", async () => {
    for (const action of ["install", "update"] as const) {
      const copy = staged()
      const { service, deps } = harness({ stageRuntime: vi.fn(async () => copy) })
      await service[action]()
      expect(deps[action], action).toHaveBeenCalledWith(expect.objectContaining({ runtime, staged: { runtime: stagedRuntime, publish: expect.any(Function) } }))
      expect(copy.publish, action).not.toHaveBeenCalled()
      // #635: the step handed over is the staged publish, with the read of
      // the copy the service runs before it.
      const handed = (vi.mocked(deps[action]).mock.calls[0] as unknown as [{ staged: { publish: () => Promise<void> } }])[0].staged.publish
      await handed()
      expect(copy.publish, action).toHaveBeenCalledOnce()
      expect(deps.runtimeCopy, action).toHaveBeenCalledOnce()
    }
  })

  it("publishes nothing when the service call refuses", async () => {
    const words = "This app's daemon uses the profile at /Users/dana/profiles/work, and the login service uses the profile at /Users/dana/.domovoi."
    const copy = staged()
    const { service } = harness({ stageRuntime: vi.fn(async () => copy), install: vi.fn(async () => { throw Object.assign(new Error(words), { name: "ServiceProfileMismatchError" }) }) })
    await expect(service.install()).resolves.toEqual({ ok: false, reason: "refused", message: words })
    expect(copy.publish).not.toHaveBeenCalled()
  })
})

// #635, ruled Q60 A: each install or update publishes a fresh runtime copy.
// Once the new service is confirmed, the copies no service definition names
// are removed. The copy the service ran before is read inside the publish,
// which the service calls run under their service-operation lease.
describe("DesktopDaemonService removes runtime copies no service names", () => {
  const plist = { kind: "file" as const, path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" }
  type Publishing = { releaseInAppDaemon?: () => Promise<void>; staged?: { publish: () => Promise<void> } }

  function publishing(overrides: Partial<ConstructorParameters<typeof DesktopDaemonService>[0]> = {}) {
    const copy = staged()
    const built = harness({
      stageRuntime: vi.fn(async () => copy),
      install: vi.fn(async (options: Publishing) => { await options.releaseInAppDaemon?.(); await options.staged?.publish(); built.calls.push("install"); return plist }),
      update: vi.fn(async (options: Publishing) => { await options.staged?.publish(); built.calls.push("update"); return plist }),
      ...overrides,
    })
    copy.publish.mockImplementation(async () => { built.calls.push("publish") })
    return built
  }

  it("reads the copy the service ran inside the publish, and removes unused copies once the new service is confirmed", async () => {
    for (const action of ["install", "update"] as const) {
      const { service, deps, calls } = publishing()
      await expect(service[action](), action).resolves.toMatchObject({ ok: true })
      expect(calls.indexOf("read service copy"), action).toBe(calls.indexOf("publish") - 1)
      expect(calls.indexOf("publish"), action).toBeLessThan(calls.indexOf(action))
      expect(calls.indexOf("remove unused copies"), action).toBeGreaterThan(calls.indexOf("attach"))
      expect(deps.removeUnusedRuntimes, action).toHaveBeenCalledExactlyOnceWith({ published: runtime, previous: { installed: true, copy: previousCopy } })
      expect(vi.mocked(deps.status).mock.invocationCallOrder.at(-1)!, action).toBeLessThan(vi.mocked(deps.removeUnusedRuntimes).mock.invocationCallOrder[0]!)
    }
  })

  it("passes on that no service ran before", async () => {
    const { service, deps } = publishing({ runtimeCopy: vi.fn(async () => ({ installed: false as const })) })
    await expect(service.install()).resolves.toMatchObject({ ok: true })
    expect(deps.removeUnusedRuntimes).toHaveBeenCalledExactlyOnceWith({ published: runtime, previous: { installed: false } })
  })

  it("removes nothing when the new service is not confirmed", async () => {
    const refused = { kind: "refused" as const, reason: "owner-incompatible" as const, message: "The daemon at this profile is older than this app." }
    const owned = { kind: "owned" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }
    const attachedToApp = { ...attachedToService, owner: "desktop" as const }
    for (const action of ["install", "update"] as const) {
      const cases = [
        publishing({ daemon: { ...harness().deps.daemon, attachOnly: vi.fn(async () => refused) } }),
        publishing({ daemon: { ...harness().deps.daemon, attachOnly: vi.fn(async () => { throw new Error("connection refused") }) } }),
        publishing({ daemon: { ...harness().deps.daemon, attachOnly: vi.fn(async () => owned) } }),
        publishing({ daemon: { ...harness().deps.daemon, attachOnly: vi.fn(async () => attachedToApp) } }),
        publishing({ status: vi.fn(async () => ({ installed: true, running: false, detail: "" })) }),
      ]
      for (const [index, { service, deps, calls }] of cases.entries()) {
        await expect(service[action](), `${action} ${index}`).resolves.toMatchObject({ ok: false })
        expect(calls, `${action} ${index}`).toContain("publish")
        expect(deps.removeUnusedRuntimes, `${action} ${index}`).not.toHaveBeenCalled()
      }
    }
  })

  it("removes nothing when the service call fails after the publish", async () => {
    const failing = publishing({
      install: vi.fn(async (options: Publishing) => { await options.releaseInAppDaemon?.(); await options.staged?.publish(); throw new Error("launchctl bootstrap failed") }),
      update: vi.fn(async (options: Publishing) => { await options.staged?.publish(); throw new Error("Domovoi could not start the service on the new runtime") }),
    })
    await expect(failing.service.install()).resolves.toMatchObject({ ok: false, reason: "failed" })
    await expect(failing.service.update()).resolves.toMatchObject({ ok: false, reason: "update-failed" })
    expect(failing.calls.filter((call) => call === "publish")).toHaveLength(2)
    expect(failing.deps.removeUnusedRuntimes).not.toHaveBeenCalled()
  })

  it("removes nothing when nothing was published or the copy the service ran could not be read", async () => {
    const unpublished = harness()
    await expect(unpublished.service.install()).resolves.toMatchObject({ ok: true })
    await expect(unpublished.service.update()).resolves.toMatchObject({ ok: true })
    expect(unpublished.deps.removeUnusedRuntimes).not.toHaveBeenCalled()
    const unread = publishing({ runtimeCopy: vi.fn(async () => { throw new Error("EACCES: permission denied") }) })
    await expect(unread.service.install()).resolves.toMatchObject({ ok: true })
    // The publish still ran: only the cleanup depends on the read.
    expect(unread.calls).toContain("publish")
    expect(unread.deps.removeUnusedRuntimes).not.toHaveBeenCalled()
  })

  it("keeps the outcome when the cleanup fails", async () => {
    for (const action of ["install", "update"] as const) {
      const { service, deps } = publishing({ removeUnusedRuntimes: vi.fn(async () => { throw new Error("EBUSY: resource busy or locked") }) })
      await expect(service[action](), action).resolves.toEqual({ ok: true, kind: "file", target: plist.path, configurationPath: plist.configurationPath, daemonRunning: true })
      expect(deps.removeUnusedRuntimes, action).toHaveBeenCalledOnce()
    }
  })
})

// Security review of #577 (P1): the turn check and the fence go through the
// daemon this app reaches, while install, remove and update act on the login
// service the saved configuration names. DOMOVOI_PROFILE_DIR can make those two
// profiles; then the check says nothing about the service, so nothing runs.
describe("DesktopDaemonService on another profile than the service's", () => {
  const mismatch = { app: "/Users/dana/profiles/work", service: "/Users/dana/.domovoi" }
  const words = "This app's daemon uses the profile at /Users/dana/profiles/work, and the login service uses the profile at /Users/dana/.domovoi."

  it("refuses install, remove and update before any check, fence or change", async () => {
    for (const action of ["install", "remove", "update"] as const) {
      const { service, deps, calls } = harness({ profile: vi.fn(async () => mismatch) })
      await expect(service[action](), action).resolves.toEqual({ ok: false, reason: "refused", message: words })
      expect(deps.refusal, action).not.toHaveBeenCalled()
      expect(deps.fence, action).not.toHaveBeenCalled()
      expect(deps.stageRuntime, action).not.toHaveBeenCalled()
      expect(deps[action], action).not.toHaveBeenCalled()
      expect(calls, action).toEqual([])
    }
  })

  it("waits when the profiles cannot be compared", async () => {
    for (const action of ["install", "remove", "update"] as const) {
      const { service, deps } = harness({ profile: vi.fn(async () => { throw new Error("service.json is not a Domovoi service configuration") }) })
      await expect(service[action](), action).resolves.toEqual({ ok: false, reason: "check-failed", message: "service.json is not a Domovoi service configuration" })
      expect(deps[action], action).not.toHaveBeenCalled()
    }
  })

  // Round 2: the service calls check the profiles again under the
  // service-operation lease, since service.json can change after the early
  // check. Their refusal changes nothing and reads as the same refusal.
  it("reports the service calls' refusal of a service whose profile is not known as a refusal", async () => {
    const unknownWords = "A login service is registered at /Users/dana/Library/LaunchAgents/sh.domovoi.domovoid.plist, but its saved configuration is missing, so the profile it runs is not known. Nothing was changed."
    const unknown = () => Object.assign(new Error(unknownWords), { name: "ServiceProfileUnknownError" })
    const install = harness({ install: vi.fn(async () => { throw unknown() }) })
    await expect(install.service.install()).resolves.toEqual({ ok: false, reason: "refused", message: unknownWords })
    const remove = harness({ remove: vi.fn(async () => { throw unknown() }) })
    await expect(remove.service.remove()).resolves.toEqual({ ok: false, reason: "refused", message: unknownWords })
    expect(remove.deps.daemon.restart).not.toHaveBeenCalled()
  })

  it("reports the service calls' own profile refusal as that refusal, with nothing stopped or restarted", async () => {
    const profileError = () => Object.assign(new Error(words), { name: "ServiceProfileMismatchError" })
    const install = harness({ install: vi.fn(async () => { throw profileError() }) })
    await expect(install.service.install()).resolves.toEqual({ ok: false, reason: "refused", message: words })
    expect(install.deps.daemon.stopOwned).not.toHaveBeenCalled()
    expect(install.deps.daemon.restart).not.toHaveBeenCalled()
    const update = harness({ update: vi.fn(async () => { throw Object.assign(new Error(`Domovoi could not update the service: ${words}`), { cause: profileError() }) }) })
    await expect(update.service.update()).resolves.toEqual({ ok: false, reason: "refused", message: words })
    const remove = harness({ remove: vi.fn(async () => { throw profileError() }) })
    await expect(remove.service.remove()).resolves.toEqual({ ok: false, reason: "refused", message: words })
    expect(remove.deps.daemon.restart).not.toHaveBeenCalled()
  })
})

describe("DesktopDaemonService", () => {
  it("stages the runtime, lets the installer stop the in-app daemon after its checks, then attaches to the service", async () => {
    const { service, deps, calls } = harness()
    await expect(service.install()).resolves.toEqual({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json", daemonRunning: true })
    expect(deps.install).toHaveBeenCalledWith(expect.objectContaining({ runtime }))
    expect(calls).toEqual(["stage", "checks", "fence", "hold", "stop", "install", "attach", "unfence", "release"])
  })

  // Ruling Q307 (review of #698, P2): a Linux install whose lingering could
  // not be turned on is not a plain success. The daemon's own warning, the
  // CLI's words, is carried to the renderer; one without it carries none.
  it("carries the daemon's lingering warning with a successful install", async () => {
    const lingerWarning = "Could not turn on lingering for dana: loginctl was not found. The service is installed, but systemd stops the daemon when dana logs out of every session and starts it again at the next login. To keep it running, run loginctl enable-linger; domovoid service remove will then leave lingering on."
    const unit = { kind: "file" as const, path: "/home/dana/.config/systemd/user/domovoid.service", configurationPath: "/home/dana/.domovoi/service.json", linger: { kind: "failed" as const, detail: "loginctl was not found" }, lingerWarning }
    const { service } = harness({ install: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { await options.releaseInAppDaemon?.(); return unit }) })
    await expect(service.install()).resolves.toEqual({ ok: true, kind: "file", target: unit.path, configurationPath: unit.configurationPath, daemonRunning: true, lingerWarning })
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
// Ruled 2026-09-23 (#577, B): "Update the service" moves the running service
// to the runtime this app ships, in place, with the same refusal as install
// and remove. Its failures carry the daemon's approved words.
describe("updating the service in place", () => {
  it("stages the runtime, updates the service while holding reconnects, then attaches to it", async () => {
    const { service, deps, calls } = harness()
    await expect(service.update()).resolves.toEqual({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json", daemonRunning: true })
    expect(deps.update).toHaveBeenCalledWith({ runtime, staged: { runtime: stagedRuntime, publish: expect.any(Function) } })
    // Owner ruling 2026-09-26 (#577, A): the daemon's fence, taken right
    // before the service restarts, as install and remove take it.
    expect(calls).toEqual(["fence", "stage", "hold", "update", "attach", "unfence", "release"])
    expect(deps.daemon.stopOwned).not.toHaveBeenCalled()
    expect(deps.daemon.restart).not.toHaveBeenCalled()
  })

  it("refuses while a turn runs or a gate waits, and when that cannot be read, before touching anything", async () => {
    const refused = harness({ refusal: vi.fn(async () => "1 gate is waiting (Fix login).") })
    await expect(refused.service.update()).resolves.toEqual({ ok: false, reason: "refused", message: "1 gate is waiting (Fix login)." })
    expect(refused.calls).toEqual([])
    const unread = harness({ refusal: vi.fn(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:47831") }) })
    await expect(unread.service.update()).resolves.toEqual({ ok: false, reason: "check-failed", message: "connect ECONNREFUSED 127.0.0.1:47831" })
    expect(unread.calls).toEqual([])
  })

  it("carries the daemon's words when the update does not end with the new service running", async () => {
    const error = new DaemonServiceUpdateError("swap-failed-restored", new Error("launchctl bootstrap exited 5"))
    const { service, deps, calls } = harness({ update: vi.fn(async () => { throw error }) })
    await expect(service.update()).resolves.toEqual({ ok: false, reason: "update-failed", message: error.message })
    expect(error.message).toBe("Domovoi could not start the service on the new runtime: launchctl bootstrap exited 5. The previous service was put back and is running.")
    expect(deps.daemon.restart).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe("release")
  })

  // Round 8 (P2), ruled 2026-09-26 (Q64 A): a runtime published and then
  // failing its check is carried in the daemon's words too.
  it("carries the daemon's words when the new runtime was copied but the service was left as it was", async () => {
    const error = new DaemonServiceUpdateError("runtime-copied", new Error("The Node runtime this app ships was not found at /home/dana/.domovoi/runtime/0.9.4/0123456789ab/node/bin/node"), undefined, "/home/dana/.domovoi/runtime/0.9.4/0123456789ab")
    const { service } = harness({ update: vi.fn(async () => { throw error }) })
    await expect(service.update()).resolves.toEqual({ ok: false, reason: "update-failed", message: error.message })
    expect(error.message).toBe("Domovoi could not update the service: The Node runtime this app ships was not found at /home/dana/.domovoi/runtime/0.9.4/0123456789ab/node/bin/node. The new runtime was copied to /home/dana/.domovoi/runtime/0.9.4/0123456789ab, but the service was left as it was, set to run the previous runtime.")
  })

  it("reports a missing shipped runtime without changing the service", async () => {
    const { service, deps } = harness({ stageRuntime: vi.fn(async () => { throw new DaemonServiceRuntimeMissingError("daemon", "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/daemon/dist/index.js", "missing") }) })
    await expect(service.update()).resolves.toMatchObject({ ok: false, reason: "runtime-missing", part: "daemon" })
    expect(deps.update).not.toHaveBeenCalled()
  })

  it("reports an updated service this app could not attach to", async () => {
    const { service, deps } = harness()
    vi.mocked(deps.daemon.attachOnly).mockImplementationOnce(async () => ({ kind: "refused", reason: "owner-unreachable", message: "The daemon did not answer" }) as never)
    await expect(service.update()).resolves.toEqual({ ok: false, reason: "installed-not-attached", kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", message: "The daemon did not answer" })
  })

  // Owner ruling 2026-09-26 (#577, A): a turn can start after the first read,
  // so the update takes the daemon's fence right before the service restarts.
  it("takes the daemon's fence before the update, and updates nothing when it refuses or cannot be taken", async () => {
    const refused = harness()
    vi.mocked(refused.deps.fence).mockImplementationOnce(async () => ({ refusal: "1 turn is running (Fix login)." }))
    await expect(refused.service.update()).resolves.toEqual({ ok: false, reason: "refused", message: "1 turn is running (Fix login)." })
    expect(refused.deps.update).not.toHaveBeenCalled()
    expect(refused.calls).toEqual([])
    expect(refused.deps.stageRuntime).not.toHaveBeenCalled()
    const unfenced = harness()
    vi.mocked(unfenced.deps.fence).mockImplementationOnce(async () => { throw new Error("The daemon closed the connection") })
    await expect(unfenced.service.update()).resolves.toEqual({ ok: false, reason: "check-failed", message: "The daemon closed the connection" })
    expect(unfenced.deps.update).not.toHaveBeenCalled()
    expect(unfenced.calls).toEqual([])
    expect(unfenced.deps.stageRuntime).not.toHaveBeenCalled()
  })

  it("releases the fence when the update fails", async () => {
    const { service, calls } = harness({ update: vi.fn(async () => { throw new Error("launchctl bootstrap exited 5") }) })
    await expect(service.update()).resolves.toMatchObject({ ok: false, reason: "update-failed" })
    expect(calls).toEqual(["fence", "stage", "hold", "unfence", "release"])
  })

  // Owner ruling 2026-09-26 (#577, A), as security review round 9 of #576
  // ruled for install: reaching a daemon after the update is not proof the
  // updated service runs it.
  it("reports success only when the attached daemon is the running service's", async () => {
    for (const [label, attach, status] of [
      ["another app's daemon", { kind: "attached", owner: "desktop", url: "ws://127.0.0.1:47831/rpc", token: "t" }, { installed: true, running: true, detail: "" }],
      ["a daemon of this app", { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t" }, { installed: true, running: true, detail: "" }],
      ["a stopped service", attachedToService, { installed: true, running: false, detail: "not loaded" }],
      ["a service whose state is unknown", attachedToService, { installed: null, running: false, detail: "" }],
    ] as const) {
      const partial = harness({ status: vi.fn(async () => status) })
      vi.mocked(partial.deps.daemon.attachOnly).mockImplementationOnce(async () => attach as never)
      await expect(partial.service.update(), label).resolves.toEqual({ ok: false, reason: "installed-not-attached", kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", message: "The daemon this window reached is not the running service." })
    }
    const unreadable = harness({ status: vi.fn(async () => { throw new Error("launchctl could not be run") }) })
    await expect(unreadable.service.update()).resolves.toMatchObject({ ok: false, reason: "installed-not-attached" })
  })

  it("refuses an update while another service change runs", async () => {
    let release!: () => void
    const { service } = harness({ install: vi.fn(() => new Promise<DaemonServiceInstallResult>((resolve) => { release = () => resolve({ kind: "file", path: "/p", configurationPath: "/c" }) })) })
    const first = service.install()
    await expect(service.update()).resolves.toMatchObject({ ok: false, reason: "busy" })
    release()
    await first
  })
})

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
      stageRuntime: async () => staged(),
      update: async () => { throw new Error("not in this test") },
      install: async (options) => {
        await options.releaseInAppDaemon?.()
        reconnect = daemon.reacquire()
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
        return { kind: "file", path: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/Users/dana/.domovoi/service.json" }
      },
      status: async () => ({ installed: true, running: true, detail: "" }),
      remove: async () => ({ kind: "file", path: "/p", profileRecovery: "not-needed" }),
      profile: async () => undefined,
      refusal: async () => undefined,
      fence: async () => ({ release: () => {} }),
      runtimeCopy: async () => ({ installed: false }),
      removeUnusedRuntimes: async () => {},
      daemon,
    })
    const outcome = await service.install()
    expect(modes).toEqual(["start-or-attach", "attach-only"])
    expect(outcome).toMatchObject({ ok: true })
    await expect(reconnect).resolves.toMatchObject({ kind: "attached", token: "service" })
  })
})

// The copy itself is the daemon's (service/runtime-stage.ts, Q408 A) and is
// tested there.
describe("staging the shipped runtime under the profile", () => {
  it("stages for an update when the service is updated", async () => {
    const { service, deps } = harness()
    await service.update()
    expect(deps.stageRuntime).toHaveBeenCalledWith("update")
  })
})

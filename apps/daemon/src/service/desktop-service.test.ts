import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  installDaemonService,
  readDaemonServiceStatus,
  removeDaemonService,
  WindowsTaskNotDomovoiError,
  WindowsTaskPercentSignError,
  type DaemonServiceDependencies,
} from "../public.js"
import { createServiceConfiguration } from "./configuration.js"
import type { ServiceEffects } from "./install.js"
import { ServiceOperationBusyError } from "./operation-lease.js"

// The desktop installs a service that runs the Node and daemon it ships, so
// the daemon keeps running after the app quits. It passes the two paths; the
// installer refuses before touching anything when either is not there.

const runtime = {
  nodePath: "/Applications/Domovoi.app/Contents/Resources/runtime/node",
  daemonEntryPath: "/Applications/Domovoi.app/Contents/Resources/runtime/daemon/dist/index.js",
}

function dependencies(overrides: Partial<DaemonServiceDependencies & ServiceEffects> = {}): DaemonServiceDependencies & ServiceEffects {
  return {
    platform: "darwin",
    home: "/Users/dl",
    uid: 501,
    user: "dl",
    runtimeFile: vi.fn(async () => "file" as const),
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    capture: vi.fn(async () => ({ code: 0, stdout: "\tstate = running\n" })),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("installDaemonService", () => {
  it("installs a launch agent that runs the shipped Node on the shipped daemon", async () => {
    const effects = dependencies()
    const installed = await installDaemonService({ runtime }, effects)
    if (installed.kind !== "file") throw new Error("expected a launch agent file")
    expect(installed).toEqual({
      kind: "file",
      path: "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist",
      configurationPath: "/Users/dl/.domovoi/service.json",
    })
    const written = vi.mocked(effects.write).mock.calls.find(([path]) => path === installed.path)![1]
    expect(written).toContain(`<string>${runtime.nodePath}</string>`)
    expect(written).toContain(`<string>${runtime.daemonEntryPath}</string>`)
    expect(effects.run).toHaveBeenCalledWith("launchctl", ["bootstrap", "gui/501", installed.path], expect.anything())
  })

  it("refuses a runtime that is not there before claiming the profile or writing a file", async () => {
    for (const [part, missing] of [["node", runtime.nodePath], ["daemon", runtime.daemonEntryPath]] as const) {
      const effects = dependencies({ runtimeFile: vi.fn(async (path: string) => path === missing ? "missing" as const : "file" as const) })
      const refused = installDaemonService({ runtime }, effects)
      await expect(refused).rejects.toBeInstanceOf(DaemonServiceRuntimeMissingError)
      await expect(refused).rejects.toMatchObject({ part, path: missing })
      await expect(refused).rejects.toThrow(/No service was installed/)
      expect(effects.claimProfile).not.toHaveBeenCalled()
      expect(effects.write).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    }
  })

  it("refuses a relative runtime path and a directory where a file should be", async () => {
    await expect(installDaemonService({ runtime: { ...runtime, nodePath: "runtime/node" } }, dependencies()))
      .rejects.toMatchObject({ part: "node", path: "runtime/node" })
    const directory = dependencies({ runtimeFile: vi.fn(async (path: string) => path === runtime.daemonEntryPath ? "not-file" as const : "file" as const) })
    await expect(installDaemonService({ runtime }, directory)).rejects.toMatchObject({ part: "daemon" })
    expect(directory.write).not.toHaveBeenCalled()
  })

  it("refuses while the profile is still owned, with nothing written", async () => {
    // The in-app daemon holds the profile until the desktop stops it.
    const effects = dependencies({ claimProfile: vi.fn(() => { throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi") }) })
    await expect(installDaemonService({ runtime }, effects)).rejects.toBeInstanceOf(ProfileAlreadyOwnedError)
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("runs a Windows logon task through the shipped node.exe", async () => {
    const effects = dependencies({ platform: "win32", home: "C:\\Users\\dl", user: "dl" })
    const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\index.js" }
    expect(await installDaemonService({ runtime: windowsRuntime }, effects)).toMatchObject({ kind: "task", name: "Domovoi daemon" })
    const created = vi.mocked(effects.run).mock.calls.find(([, args]) => args[0] === "/create")![1]
    expect(created[created.indexOf("/tr") + 1]).toMatch(/^"C:\\Program Files\\Domovoi\\runtime\\node\.exe" "C:\\Program Files\\Domovoi\\runtime\\daemon\\index\.js" --service-config /)
  })
})

describe("the handoff from the in-app daemon", () => {
  // Ruled 2026-09-23 (J24, option B): the installer asks the desktop to stop
  // its in-app daemon only once the runtime and platform checks pass, and
  // before it claims the profile. A refused install never stops it.
  it("never releases the in-app daemon when the runtime or platform is refused", async () => {
    const missing = dependencies({ runtimeFile: vi.fn(async () => "missing" as const) })
    const releaseInAppDaemon = vi.fn(async () => {})
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, missing)).rejects.toBeInstanceOf(DaemonServiceRuntimeMissingError)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()

    const unsupported = dependencies({ platform: "freebsd", home: "/home/dl" })
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, unsupported)).rejects.toThrow(/no service manager/)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(unsupported.claimProfile).not.toHaveBeenCalled()

    const token = dependencies()
    await expect(installDaemonService({ runtime, releaseInAppDaemon, environment: { DOMOVOI_AUTH_TOKEN: "x" } }, token)).rejects.toThrow(/DOMOVOI_AUTH_TOKEN/)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
  })

  it("releases the in-app daemon exactly once, before the profile is claimed", async () => {
    const order: string[] = []
    const releaseInAppDaemon = vi.fn(async () => { order.push("release") })
    const effects = dependencies({
      claimProfile: vi.fn(() => { order.push("claim"); return { release: vi.fn() } }),
      write: vi.fn(async (path: string) => { order.push(`write ${path}`) }),
    })
    await installDaemonService({ runtime, releaseInAppDaemon }, effects)
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(order[0]).toBe("release")
    expect(order.indexOf("claim")).toBeGreaterThan(0)
  })

  it("stops when the release fails, with nothing claimed or written", async () => {
    const effects = dependencies()
    const releaseInAppDaemon = vi.fn(async () => { throw new Error("in-app daemon did not stop") })
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, effects)).rejects.toThrow(/did not stop/)
    expect(effects.claimProfile).not.toHaveBeenCalled()
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })
})

describe("readDaemonServiceStatus and removeDaemonService", () => {
  it("report the launch agent and remove it", async () => {
    const effects = dependencies()
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: true, running: true })
    expect(await removeDaemonService(effects)).toMatchObject({
      kind: "file", path: "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist", profileRecovery: "not-needed",
    })
    expect(effects.run).toHaveBeenCalledWith("launchctl", ["bootout", "gui/501/sh.domovoi.domovoid"], expect.anything())
  })
})

// Security review round 1 on #574. Each case below was a refusal, a command
// line or a report the review showed wrong at b61813a2.
const windowsHome = "C:\\Users\\dl"
const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\index.js" }
const windowsConfigurationPath = "C:\\Users\\dl\\.domovoi\\service.json"

function windowsDependencies(overrides: Partial<DaemonServiceDependencies & ServiceEffects> = {}) {
  return dependencies({ platform: "win32", home: windowsHome, user: "dl", ...overrides })
}

function createdTaskCommand(effects: ServiceEffects): string {
  const created = vi.mocked(effects.run).mock.calls.find(([, args]) => args[0] === "/create")![1]
  return created[created.indexOf("/tr") + 1]!
}

describe("security review round 1: the handoff waits for the operation lease", () => {
  it("never releases the in-app daemon when another service operation holds the lease", async () => {
    const releaseInAppDaemon = vi.fn(async () => {})
    const effects = dependencies({ claimServiceOperation: vi.fn(() => { throw new ServiceOperationBusyError("/Users/dl/.domovoi/service-operation-lease.sqlite") }) })
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, effects)).rejects.toBeInstanceOf(ServiceOperationBusyError)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(effects.claimProfile).not.toHaveBeenCalled()
    expect(effects.write).not.toHaveBeenCalled()
  })

  it("never releases the in-app daemon when the saved registration cannot be read", async () => {
    const releaseInAppDaemon = vi.fn(async () => {})
    const effects = dependencies({ registeredProfile: vi.fn(() => { throw new Error("service.json is not a Domovoi service configuration") }) })
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, effects)).rejects.toThrow(/not a Domovoi service configuration/)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(effects.claimProfile).not.toHaveBeenCalled()
  })

  it("releases once, inside the operation lease and before the profile is claimed", async () => {
    const order: string[] = []
    const releaseInAppDaemon = vi.fn(async () => { order.push("release") })
    const effects = dependencies({
      claimServiceOperation: vi.fn(() => { order.push("operation"); return { release: vi.fn(() => { order.push("operation released") }) } }),
      claimProfile: vi.fn(() => { order.push("profile"); return { release: vi.fn() } }),
    })
    await installDaemonService({ runtime, releaseInAppDaemon }, effects)
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(order.slice(0, 3)).toEqual(["operation", "release", "profile"])
    expect(order.at(-1)).toBe("operation released")
  })
})

describe("security review round 1: the Windows task command", () => {
  // Task Scheduler expands %NAME% in an action's program and arguments when
  // the task runs, so a path that contains a percent sign would not name the
  // file that was checked.
  it("refuses a percent sign in any path the task runs, before the handoff", async () => {
    for (const [runtimePaths, home] of [
      [{ ...windowsRuntime, nodePath: "C:\\Program Files\\%ODD%\\node.exe" }, windowsHome],
      [{ ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi\\%ODD%\\index.js" }, windowsHome],
      [windowsRuntime, "C:\\Users\\%ODD%"],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = windowsDependencies({ home })
      const refused = installDaemonService({ runtime: runtimePaths, releaseInAppDaemon }, effects)
      await expect(refused).rejects.toBeInstanceOf(WindowsTaskPercentSignError)
      await expect(refused).rejects.toThrow(/percent sign/)
      expect(releaseInAppDaemon).not.toHaveBeenCalled()
      expect(effects.claimServiceOperation).not.toHaveBeenCalled()
      expect(effects.write).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    }
  })

  it("runs an extensionless daemon entry through the shipped node.exe", async () => {
    const effects = windowsDependencies()
    const extensionless = { ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\domovoid" }
    await installDaemonService({ runtime: extensionless }, effects)
    expect(createdTaskCommand(effects)).toBe(
      `"${extensionless.nodePath}" "${extensionless.daemonEntryPath}" --service-config "${windowsConfigurationPath}"`,
    )
  })
})

// A fake Task Scheduler behind the PowerShell bridge: one task, with the
// program and arguments it runs, whether it is enabled and running.
function taskScheduler(task: { path: string; arguments: string } | undefined) {
  const state = { registered: task !== undefined, enabled: true, running: true, stopIssued: false, deleted: false }
  const capture = vi.fn(async (_command: string, args: string[]) => {
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
    if (!state.registered) return { code: 0, stdout: "domovoi-task:missing\r\n" }
    if (script.includes("domovoi-task-action:")) {
      return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ path: task!.path, arguments: task!.arguments, enabled: state.enabled, state: state.running ? 4 : state.enabled ? 3 : 1 })}\r\n` }
    }
    if (script.includes("$task.Enabled = $false")) { state.enabled = false; state.stopIssued = true }
    if (script.includes("$task.Stop(0)")) state.running = false
    if (script.includes("$folder.DeleteTask(")) {
      state.registered = false
      state.deleted = true
      return { code: 0, stdout: "domovoi-task:deleted\r\n" }
    }
    return { code: 0, stdout: `domovoi-task:${state.running ? 4 : state.enabled ? 3 : 1}\r\n` }
  })
  return { state, capture }
}

const domovoiTask = { path: `"${windowsRuntime.nodePath}"`, arguments: `"${windowsRuntime.daemonEntryPath}" --service-config "${windowsConfigurationPath}"` }
const savedConfiguration = { ...createServiceConfiguration({}, { platform: "win32", homeDirectory: windowsHome, workingDirectory: windowsHome }), registrationId: "5f0c7a9e-8a3b-4d1e-9c2f-0a1b2c3d4e5f" }

describe("security review round 1: a same-named Windows task is not Domovoi's", () => {
  beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
  afterEach(() => { vi.unstubAllEnvs() })

  it("does not report a task with no Domovoi registration as installed", async () => {
    for (const [task, saved] of [
      [{ path: "C:\\Tools\\other.exe", arguments: "--serve" }, undefined],
      [domovoiTask, undefined],
      [{ path: "C:\\Tools\\other.exe", arguments: "--serve" }, savedConfiguration],
      [{ ...domovoiTask, arguments: `"${windowsRuntime.daemonEntryPath}" --service-config "C:\\Users\\dl\\elsewhere.json"` }, savedConfiguration],
    ] as const) {
      const scheduler = taskScheduler(task)
      const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => saved) })
      expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: false, running: false })
    }
  })

  it("refuses to stop or delete a task with no Domovoi registration", async () => {
    const scheduler = taskScheduler({ path: "C:\\Tools\\other.exe", arguments: "--serve" })
    const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => undefined) })
    const refused = removeDaemonService(effects)
    await expect(refused).rejects.toBeInstanceOf(WindowsTaskNotDomovoiError)
    await expect(refused).rejects.toThrow(/Domovoi did not register/)
    expect(scheduler.state).toMatchObject({ registered: true, enabled: true, running: true, stopIssued: false, deleted: false })
    expect(effects.remove).not.toHaveBeenCalled()
    expect(effects.claimProfile).not.toHaveBeenCalled()
  })

  it("reports and removes the task Domovoi registered", async () => {
    const scheduler = taskScheduler(domovoiTask)
    const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => savedConfiguration) })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: true, running: true })
    expect(await removeDaemonService(effects)).toMatchObject({ kind: "task", name: "Domovoi daemon" })
    expect(scheduler.state).toMatchObject({ registered: false, deleted: true })
    expect(effects.remove).toHaveBeenCalledWith(windowsConfigurationPath, expect.anything())
  })

  it("still reports and removes nothing when no task is registered", async () => {
    const scheduler = taskScheduler(undefined)
    const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => savedConfiguration) })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: false, running: false })
    expect(await removeDaemonService(effects)).toMatchObject({ kind: "task" })
  })
})

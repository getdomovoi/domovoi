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
import { createServiceConfiguration, parseServiceConfiguration } from "./configuration.js"
import type { ServiceEffects } from "./install.js"
import { ServiceOperationBusyError } from "./operation-lease.js"
import { DaemonServiceHandoffError, LaunchdJobNotDomovoiError, WindowsTaskArgumentVariableError, WindowsTaskPathError } from "./desktop-service.js"

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
    capture: vi.fn(async () => ({ code: 0, stdout: "\tpath = /Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist\n\tstate = running\n" })),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    ...overrides,
  }
}

// Security review round 3: a Windows install first asks Task Scheduler
// whether a task of the same name exists, through PowerShell under SystemRoot.
// Windows fakes answer that none does unless a test says otherwise.
const noTask = () => vi.fn(async () => ({ code: 0, stdout: "domovoi-task:missing\r\n" }))
beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
afterEach(() => { vi.unstubAllEnvs() })

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

  // Ruled 2026-09-24 (A): the install records the runtime and daemon entry it
  // installed in its own service.json; an update's rollback starts only those.
  it("records the installed runtime and daemon entry in service.json on every platform", async () => {
    const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\index.js" }
    for (const [platform, home, shipped] of [
      ["darwin", "/Users/dl", runtime],
      ["linux", "/home/dl", runtime],
      ["win32", "C:\\Users\\dl", windowsRuntime],
    ] as const) {
      const effects = dependencies({ platform, home, ...(platform === "win32" ? { capture: noTask() } : {}) })
      const installed = await installDaemonService({ runtime: shipped }, effects)
      const written = vi.mocked(effects.write).mock.calls.find(([path]) => path === installed.configurationPath)![1]
      expect(parseServiceConfiguration(written).serviceRuntime).toEqual({ executable: shipped.nodePath, entry: shipped.daemonEntryPath })
    }
  })

  it("runs a Windows logon task through the shipped node.exe", async () => {
    const effects = dependencies({ platform: "win32", home: "C:\\Users\\dl", user: "dl", capture: noTask() })
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

  // Security review round 2: the profile is checked before the handoff by a
  // claim that lets it go at once; the service's claim follows the handoff.
  it("releases the in-app daemon exactly once, before the profile is claimed for the service", async () => {
    const order: string[] = []
    const releaseInAppDaemon = vi.fn(async () => { order.push("release") })
    const effects = dependencies({
      claimProfile: vi.fn(() => { order.push("claim"); return { release: vi.fn(() => { order.push("claim released") }) } }),
      write: vi.fn(async (path: string) => { order.push(`write ${path}`) }),
    })
    await installDaemonService({ runtime, releaseInAppDaemon }, effects)
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(order.slice(0, 4)).toEqual(["claim", "claim released", "release", "claim"])
  })

  it("stops when the release fails, with nothing claimed or written", async () => {
    const probe = { release: vi.fn() }
    const effects = dependencies({ claimProfile: vi.fn(() => probe) })
    const releaseInAppDaemon = vi.fn(async () => { throw new Error("in-app daemon did not stop") })
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, effects)).rejects.toThrow(/did not stop/)
    // Only the check's claim, let go before the handoff; none for the service.
    expect(effects.claimProfile).toHaveBeenCalledOnce()
    expect(probe.release).toHaveBeenCalledOnce()
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
  return dependencies({ platform: "win32", home: windowsHome, user: "dl", capture: noTask(), ...overrides })
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
    // Round 2: the profile check's claim, let go at once, precedes the handoff.
    expect(order.slice(0, 4)).toEqual(["operation", "profile", "release", "profile"])
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
// A desktop install records the runtime it installed in service.json.
const savedConfiguration = {
  ...createServiceConfiguration({}, { platform: "win32", homeDirectory: windowsHome, workingDirectory: windowsHome }),
  registrationId: "5f0c7a9e-8a3b-4d1e-9c2f-0a1b2c3d4e5f",
  serviceRuntime: { executable: windowsRuntime.nodePath, entry: windowsRuntime.daemonEntryPath },
}

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

// Security review round 2 on #574: a task that runs any absolute program with
// the saved service.json path passed as Domovoi's. The task must run the
// runtime and entry service.json records, compared as written; an install
// from before that record must run node.exe on a Domovoi daemon entry.
describe("security review round 2: the task must run Domovoi's runtime", () => {
  beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
  afterEach(() => { vi.unstubAllEnvs() })

  const { serviceRuntime: _recorded, ...unrecorded } = savedConfiguration
  const unrelated = [
    { path: "C:\\Tools\\other.exe", arguments: `"C:\\Tools\\payload.js" --service-config "${windowsConfigurationPath}"` },
    { path: "C:\\Tools\\other.exe", arguments: `--service-config "${windowsConfigurationPath}"` },
  ]
  const cases = [
    ...unrelated.map((task) => [task, savedConfiguration] as const),
    ...unrelated.map((task) => [task, unrecorded] as const),
    // Recorded: a Domovoi-looking entry that is not the recorded one.
    [{ path: `"${windowsRuntime.nodePath}"`, arguments: `"C:\\Users\\dl\\AppData\\Roaming\\npm\\node_modules\\@getdomovoi\\daemon\\dist\\index.js" --service-config "${windowsConfigurationPath}"` }, savedConfiguration],
    // Recorded, differing only in case.
    [{ path: `"${windowsRuntime.nodePath.toLowerCase()}"`, arguments: `"${windowsRuntime.daemonEntryPath}" --service-config "${windowsConfigurationPath}"` }, savedConfiguration],
  ] as const

  it("does not report a task that runs anything but that runtime as installed", async () => {
    for (const [task, saved] of cases) {
      const scheduler = taskScheduler(task)
      const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => saved) })
      expect(await readDaemonServiceStatus(effects), task.path).toMatchObject({ installed: false, running: false })
    }
  })

  it("refuses to stop or delete a task that runs anything but that runtime", async () => {
    for (const [task, saved] of cases) {
      const scheduler = taskScheduler(task)
      const effects = windowsDependencies({ capture: scheduler.capture, readConfiguration: vi.fn(() => saved) })
      await expect(removeDaemonService(effects)).rejects.toBeInstanceOf(WindowsTaskNotDomovoiError)
      expect(scheduler.state).toMatchObject({ registered: true, stopIssued: false, deleted: false })
      expect(effects.remove).not.toHaveBeenCalled()
      expect(effects.claimProfile).not.toHaveBeenCalled()
    }
  })
})

// Security review round 2 on #574, findings 2 to 4.
describe("security review round 2: a job under Domovoi's label needs Domovoi's file", () => {
  const agentPath = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  const loadedFrom = (path: string) => vi.fn(async () => ({ code: 0, stdout: `\tpath = ${path}\n\tstate = running\n` }))

  it("with no launch agent file, reports nothing installed or running and boots nothing out", async () => {
    const effects = dependencies({ exists: vi.fn(async () => false), capture: loadedFrom("/Users/dl/Library/LaunchAgents/other.plist") })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: false, running: false })
    await removeDaemonService(effects)
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("with no systemd unit file, reports nothing installed or running and stops nothing", async () => {
    const effects = dependencies({ platform: "linux", home: "/home/dl", exists: vi.fn(async () => false), capture: vi.fn(async () => ({ code: 0, stdout: "active\n" })) })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: false, running: false })
    await removeDaemonService(effects)
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("does not report or boot out a job loaded from another plist", async () => {
    const effects = dependencies({ capture: loadedFrom("/Users/dl/Library/LaunchAgents/other.plist") })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: true, running: false })
    await removeDaemonService(effects)
    expect(effects.run).not.toHaveBeenCalled()
    expect(effects.remove).toHaveBeenCalledWith(agentPath, expect.anything())
  })

  it("reports and boots out the job loaded from Domovoi's plist", async () => {
    const effects = dependencies({ capture: loadedFrom(agentPath) })
    expect(await readDaemonServiceStatus(effects)).toMatchObject({ installed: true, running: true })
    await removeDaemonService(effects)
    expect(effects.run).toHaveBeenCalledWith("launchctl", ["bootout", "gui/501/sh.domovoi.domovoid"], expect.anything())
  })
})

describe("security review round 2: the handoff waits for the profile check", () => {
  const owner = (kind: "daemon" | "desktop") => ({
    version: 1 as const, state: "ready" as const, instanceId: "8c1b5a4e-2f3d-4c5b-9a6e-7d8f9a0b1c2d", machineId: `machine-${"a".repeat(32)}`,
    protocolVersion: "0.7.0", owner: kind, credential: { source: "environment" as const }, url: "ws://127.0.0.1:47831/rpc",
  })
  const held = () => vi.fn(() => { throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi") })

  it("never releases the in-app daemon while another daemon owns the profile", async () => {
    for (const readOwner of [vi.fn(() => owner("daemon")), vi.fn(() => undefined), vi.fn(() => { throw new Error("unreadable") })]) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = dependencies({ claimProfile: held(), readOwner })
      await expect(installDaemonService({ runtime, releaseInAppDaemon }, effects)).rejects.toBeInstanceOf(ProfileAlreadyOwnedError)
      expect(releaseInAppDaemon).not.toHaveBeenCalled()
      expect(effects.write).not.toHaveBeenCalled()
    }
  })

  it("releases the in-app daemon that owns the profile, once, then claims it", async () => {
    const order: string[] = []
    let inApp = true
    const releaseInAppDaemon = vi.fn(async () => { order.push("release"); inApp = false })
    const effects = dependencies({
      readOwner: vi.fn(() => inApp ? owner("desktop") : undefined),
      claimProfile: vi.fn(() => {
        order.push("claim")
        if (inApp) throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi")
        return { release: vi.fn() }
      }),
    })
    await installDaemonService({ runtime, releaseInAppDaemon }, effects)
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(order).toEqual(["claim", "release", "claim"])
  })

  it("says the in-app daemon was stopped when another daemon takes the profile after the handoff", async () => {
    const releaseInAppDaemon = vi.fn(async () => {})
    const effects = dependencies({ claimProfile: held(), readOwner: vi.fn(() => owner("desktop")) })
    const refused = installDaemonService({ runtime, releaseInAppDaemon }, effects)
    await expect(refused).rejects.toBeInstanceOf(DaemonServiceHandoffError)
    await expect(refused).rejects.toMatchObject({ cause: expect.any(ProfileAlreadyOwnedError) })
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })
})

describe("security review round 2: Task Scheduler argument variables", () => {
  // Task Scheduler substitutes $(Arg0) and the like in an action's arguments
  // when the task runs with parameters.
  it("refuses $( in any path the task runs, before the handoff", async () => {
    for (const [runtimePaths, home] of [
      [{ ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi\\$(Arg0)\\index.js" }, windowsHome],
      [{ ...windowsRuntime, nodePath: "C:\\Program Files\\$(Arg1)\\node.exe" }, windowsHome],
      [windowsRuntime, "C:\\Users\\$(Arg0)"],
      [windowsRuntime, "C:\\Users\\$(Anything)"],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = windowsDependencies({ home })
      const refused = installDaemonService({ runtime: runtimePaths, releaseInAppDaemon }, effects)
      await expect(refused).rejects.toBeInstanceOf(WindowsTaskArgumentVariableError)
      expect(releaseInAppDaemon).not.toHaveBeenCalled()
      expect(effects.claimServiceOperation).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    }
  })
})

// Security review round 3 on #574. A stateful fake: files, a Task Scheduler
// task with its action, and a launchd job that refuses a second bootstrap
// while its label is loaded, as launchd does.
function managerFake(platform: "darwin" | "linux" | "win32", start: {
  files?: Record<string, string>
  task?: { path: string; arguments: string }
  job?: { path: string; running: boolean }
  failing?: string
  // How many calls of the failing command fail, from the first. Default 1.
  failures?: number
  // A file write that fails, by path.
  failingWrite?: string
} = {}) {
  const home = platform === "win32" ? windowsHome : platform === "darwin" ? "/Users/dl" : "/home/dl"
  const files = new Map(Object.entries(start.files ?? {}))
  let task = start.task
  let job = start.job
  const ran: string[] = []
  let failuresLeft = start.failures ?? 1
  const effects = dependencies({
    platform, home, ...(platform === "win32" ? { user: "dl" } : {}),
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" })
      return text
    }),
    write: vi.fn(async (path: string, contents: string) => {
      if (path === start.failingWrite && contents !== start.files?.[path]) throw new Error(`write ${path} failed`)
      files.set(path, contents)
    }),
    remove: vi.fn(async (path: string) => { files.delete(path) }),
    readConfiguration: vi.fn(() => {
      const text = files.get(platform === "win32" ? windowsConfigurationPath : `${home}/.domovoi/service.json`)
      return text === undefined ? undefined : parseServiceConfiguration(text)
    }),
    run: vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args[0]}`
      ran.push(line)
      if (start.failing === args[0] && failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error(`${line} failed`)
      }
      if (args[0] === "/create") task = { path: `"${args[args.indexOf("/tr") + 1]!.split('" "')[0]!.slice(1)}"`, arguments: args[args.indexOf("/tr") + 1]!.split('" ').slice(1).join('" ') }
      if (args[0] === "bootout") job = undefined
      if (args[0] === "bootstrap") {
        if (job) throw new Error("Bootstrap failed: 5: Input/output error")
        job = { path: args[2]!, running: true }
      }
    }),
    capture: vi.fn(async (command: string, args: string[]) => {
      if (command === "launchctl") {
        return job
          ? { code: 0, stdout: `\tpath = ${job.path}\n\tstate = ${job.running ? "running" : "not running"}\n` }
          : { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
      }
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (!task) return { code: 0, stdout: "domovoi-task:missing\r\n" }
      if (script.includes("domovoi-task-action:")) return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ ...task, enabled: true, state: 3 })}\r\n` }
      return { code: 0, stdout: "domovoi-task:3\r\n" }
    }),
  })
  return { effects, files, ran, task: () => task, job: () => job }
}

describe("security review round 3", () => {
  beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
  afterEach(() => { vi.unstubAllEnvs() })

  const oldWindowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime-1\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js" }
  const oldWindowsConfiguration = JSON.stringify({ ...savedConfiguration, serviceRuntime: { executable: oldWindowsRuntime.nodePath, entry: oldWindowsRuntime.daemonEntryPath } })
  const oldWindowsTask = { path: `"${oldWindowsRuntime.nodePath}"`, arguments: `"${oldWindowsRuntime.daemonEntryPath}" --service-config "${windowsConfigurationPath}"` }

  // Finding 1: the record must name what the manager registered.
  it("puts the previous service.json back when the new Windows task cannot be registered", async () => {
    const fake = managerFake("win32", { files: { [windowsConfigurationPath]: oldWindowsConfiguration }, task: oldWindowsTask, failing: "/create" })
    await expect(installDaemonService({ runtime: windowsRuntime }, fake.effects)).rejects.toThrow("schtasks /create failed")
    expect(fake.files.get(windowsConfigurationPath)).toBe(oldWindowsConfiguration)
    expect(await readDaemonServiceStatus(fake.effects)).toMatchObject({ installed: true })
  })

  it("says so when the previous service.json cannot be put back either", async () => {
    const fake = managerFake("win32", { files: { [windowsConfigurationPath]: oldWindowsConfiguration }, task: oldWindowsTask, failing: "/create" })
    const write = fake.effects.write
    fake.effects.write = vi.fn(async (path: string, contents: string, deadline) => {
      if (contents === oldWindowsConfiguration) throw new Error("disk full")
      await write(path, contents, deadline)
    })
    await expect(installDaemonService({ runtime: windowsRuntime }, fake.effects))
      .rejects.toThrow("schtasks /create failed. Putting back the previous service files also failed: disk full.")
  })

  it("removes a new service.json when a first Windows task cannot be registered", async () => {
    const fake = managerFake("win32", { failing: "/create" })
    await expect(installDaemonService({ runtime: windowsRuntime }, fake.effects)).rejects.toThrow("schtasks /create failed")
    expect(fake.files.has(windowsConfigurationPath)).toBe(false)
  })

  it("puts the previous launch agent and service.json back when launchd refuses the new agent", async () => {
    const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
    const configuration = "/Users/dl/.domovoi/service.json"
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, failing: "bootstrap" })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow("launchctl bootstrap failed")
    expect(Object.fromEntries(fake.files)).toEqual({ [agent]: "old agent", [configuration]: "old configuration" })
  })

  it("keeps the new unit and record once systemd has loaded them", async () => {
    const fake = managerFake("linux", { files: { "/home/dl/.config/systemd/user/domovoid.service": "old unit" }, failing: "--user" })
    fake.effects.run = vi.fn(async (command: string, args: string[]) => { if (args.includes("enable")) throw new Error("enable failed") })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow("enable failed")
    expect(fake.files.get("/home/dl/.config/systemd/user/domovoid.service")).not.toBe("old unit")
  })

  // Finding 2: install refuses what ownership could not recognise later.
  it("refuses a Windows path that is not in plain form, before the handoff", async () => {
    for (const [runtimePaths, home] of [
      [{ ...windowsRuntime, nodePath: "C:\\Program Files\\Domovoi\\..\\Domovoi\\runtime\\node.exe" }, windowsHome],
      [{ ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\\\daemon\\index.js" }, windowsHome],
      [{ ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi/runtime\\daemon\\index.js" }, windowsHome],
      [{ ...windowsRuntime, daemonEntryPath: "C:\\Program Files\\Domovoi\\run\x7ftime\\daemon\\index.js" }, windowsHome],
      [windowsRuntime, "C:\\Users\\d\x7fl"],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = windowsDependencies({ home })
      await expect(installDaemonService({ runtime: runtimePaths, releaseInAppDaemon }, effects)).rejects.toBeInstanceOf(WindowsTaskPathError)
      expect(releaseInAppDaemon).not.toHaveBeenCalled()
      expect(effects.claimServiceOperation).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    }
  })

  // Finding 3: /create /f must not overwrite a task Domovoi did not register.
  it("refuses to install over a same-named task Domovoi did not register, before the handoff", async () => {
    const foreign = { path: "C:\\Tools\\other.exe", arguments: "--serve" }
    const fake = managerFake("win32", { task: foreign })
    const releaseInAppDaemon = vi.fn(async () => {})
    const refused = installDaemonService({ runtime: windowsRuntime, releaseInAppDaemon }, fake.effects)
    await expect(refused).rejects.toBeInstanceOf(WindowsTaskNotDomovoiError)
    await expect(refused).rejects.toThrow('A Windows task named "Domovoi daemon" exists, but Domovoi did not register it. Nothing was stopped or deleted.')
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(fake.effects.claimProfile).not.toHaveBeenCalled()
    expect(fake.ran).toEqual([])
    expect(fake.files.size).toBe(0)
    expect(fake.task()).toEqual(foreign)
  })

  it("reinstalls over the task Domovoi registered", async () => {
    const fake = managerFake("win32", { files: { [windowsConfigurationPath]: oldWindowsConfiguration }, task: oldWindowsTask })
    await installDaemonService({ runtime: windowsRuntime }, fake.effects)
    expect(fake.ran).toEqual(["schtasks /create", "schtasks /run"])
  })

  // Finding 4: a job still loaded from Domovoi's plist, but not running,
  // leaves the profile free; launchd would refuse the new bootstrap after the
  // in-app daemon was released.
  it("boots out an idle job loaded from Domovoi's plist before bootstrapping the new agent", async () => {
    const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
    const fake = managerFake("darwin", { files: { [agent]: "old agent" }, job: { path: agent, running: false } })
    const releaseInAppDaemon = vi.fn(async () => {})
    await installDaemonService({ runtime, releaseInAppDaemon }, fake.effects)
    expect(releaseInAppDaemon).toHaveBeenCalledOnce()
    expect(fake.ran).toEqual(["launchctl bootout", "launchctl bootstrap"])
    expect(fake.job()).toEqual({ path: agent, running: true })
  })

  it("refuses before the handoff when a job under the label is loaded from another plist", async () => {
    const other = "/Users/dl/Library/LaunchAgents/other.plist"
    const fake = managerFake("darwin", { job: { path: other, running: false } })
    const releaseInAppDaemon = vi.fn(async () => {})
    await expect(installDaemonService({ runtime, releaseInAppDaemon }, fake.effects)).rejects.toBeInstanceOf(LaunchdJobNotDomovoiError)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(fake.ran).toEqual([])
    expect(fake.files.size).toBe(0)
  })
})

// Security review round 4 on #574: a failed install leaves the previous service
// files and the manager's state, loaded or not, as they were.
describe("security review round 4", () => {
  const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  const configuration = "/Users/dl/.domovoi/service.json"
  const unit = "/home/dl/.config/systemd/user/domovoid.service"

  it("loads the previous launch agent again when the new one fails to bootstrap after the bootout", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, job: { path: agent, running: false }, failing: "bootstrap" })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow("launchctl bootstrap failed")
    expect(Object.fromEntries(fake.files)).toEqual({ [agent]: "old agent", [configuration]: "old configuration" })
    expect(fake.job()?.path).toBe(agent)
    expect(fake.ran).toEqual(["launchctl bootout", "launchctl bootstrap", "launchctl bootstrap"])
  })

  it("says so when the previous launch agent cannot be loaded again either", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, job: { path: agent, running: false }, failing: "bootstrap", failures: 2 })
    await expect(installDaemonService({ runtime }, fake.effects))
      .rejects.toThrow("launchctl bootstrap failed. Putting back the previous service files also failed: launchctl bootstrap failed.")
    expect(Object.fromEntries(fake.files)).toEqual({ [agent]: "old agent", [configuration]: "old configuration" })
  })

  it("puts service.json back when the launch agent cannot be written", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, failingWrite: agent })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow(`write ${agent} failed`)
    expect(Object.fromEntries(fake.files)).toEqual({ [agent]: "old agent", [configuration]: "old configuration" })
    expect(fake.ran).toEqual([])
  })

  it("removes a new service.json when a first systemd unit cannot be written", async () => {
    const fake = managerFake("linux", { failingWrite: unit })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow(`write ${unit} failed`)
    expect(fake.files.size).toBe(0)
    expect(fake.ran).toEqual([])
  })
})

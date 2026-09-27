import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  installDaemonService,
  readDaemonServiceRuntimeVersion,
  readDaemonServiceStatus,
  removeDaemonService,
  WindowsTaskNotDomovoiError,
  WindowsTaskPercentSignError,
  type DaemonServiceDependencies,
} from "../public.js"
import { createServiceConfiguration, parseServiceConfiguration, ServiceProfileMismatchError, ServiceProfileUnknownError } from "./configuration.js"
import type { ServiceEffects } from "./install.js"
import { ServiceOperationBusyError } from "./operation-lease.js"
import { DaemonServiceHandoffError, LaunchdJobNotDomovoiError, SystemdPathCharacterError, WindowsTaskArgumentVariableError, WindowsTaskPathError } from "./desktop-service.js"

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

// Ruled 2026-09-23 (#577, A): the version of the runtime a login service runs
// is read from the service's own definition, where the desktop's staged copy
// names it (<profile>/runtime/<version>/). Read-only: nothing is written or run
// except the Windows query, which only reads the task.
describe("readDaemonServiceRuntimeVersion", () => {
  const plist = (program: string, entry: string) => `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>${program}</string><string>${entry}</string></array></dict></plist>`
  // Security review round 4 of #577 (P3): the version is reported only for
  // the program the definition runs, and only when it is the runtime staged
  // under the profile the saved configuration names.
  const saved = (platform: string, home: string, profile?: string) => vi.fn(() => createServiceConfiguration(profile === undefined ? {} : { DOMOVOI_PROFILE_DIR: profile }, { platform, homeDirectory: home, workingDirectory: home }))

  it("names the staged runtime version a launchd agent runs", async () => {
    const readDefinition = vi.fn(async () => plist("/Users/dana/.domovoi/runtime/0.9.2/0123456789ab/node/bin/node", "/Users/dana/.domovoi/runtime/0.9.2/0123456789ab/daemon/dist/index.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }))
      .resolves.toEqual({ installed: true, version: "0.9.2" })
    expect(readDefinition).toHaveBeenCalledWith("/Users/dana/Library/LaunchAgents/sh.domovoi.domovoid.plist")
  })

  it("names the staged runtime version a systemd user unit runs", async () => {
    const unit = "[Service]\nExecStart=\"/home/dana/.domovoi/runtime/0.10.0-rc.1/0123456789ab/node/bin/node\" \"/home/dana/.domovoi/runtime/0.10.0-rc.1/0123456789ab/daemon/dist/index.js\" --service-config x\n"
    await expect(readDaemonServiceRuntimeVersion({ platform: "linux", home: "/home/dana", readDefinition: async () => unit, capture: vi.fn(), readConfiguration: saved("linux", "/home/dana") }))
      .resolves.toEqual({ installed: true, version: "0.10.0-rc.1" })
  })

  it("names the staged runtime version a Windows logon task runs", async () => {
    const xml = "<Task><Actions><Exec><Command>\"C:\\Users\\dana\\.domovoi\\runtime\\0.9.2\\0123456789ab\\node\\node.exe\"</Command><Arguments>\"C:\\Users\\dana\\.domovoi\\runtime\\0.9.2\\0123456789ab\\daemon\\dist\\index.js\"</Arguments></Exec></Actions></Task>"
    const capture = vi.fn(async () => ({ code: 0, stdout: xml }))
    await expect(readDaemonServiceRuntimeVersion({ platform: "win32", home: "C:\\Users\\dana", readDefinition: vi.fn(), capture, readConfiguration: saved("win32", "C:\\Users\\dana") }))
      .resolves.toEqual({ installed: true, version: "0.9.2" })
    expect(capture).toHaveBeenCalledWith("schtasks", ["/query", "/tn", "Domovoi daemon", "/xml"], expect.anything())
  })

  // Security review round 3 of #577: the desktop stages under the selected
  // profile, so a service on another profile runs <profile>/runtime/<version>.
  it("names the staged runtime version under a profile other than ~/.domovoi", async () => {
    const readDefinition = vi.fn(async () => plist("/Users/dana/profiles/work/runtime/0.9.2/0123456789ab/node/bin/node", "/Users/dana/profiles/work/runtime/0.9.2/0123456789ab/daemon/dist/index.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana", "/Users/dana/profiles/work") }))
      .resolves.toEqual({ installed: true, version: "0.9.2" })
    const other = vi.fn(async () => plist("/opt/runtime/1.2.3/bin/node", "/opt/tools/runtime/1.2.3/main.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: other, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana", "/Users/dana/profiles/work") }))
      .resolves.toEqual({ installed: true })
  })

  it("reports no version for another profile's runtime, a runtime named anywhere but the program, or no saved profile", async () => {
    const foreign = vi.fn(async () => plist("/Users/dana/profiles/other/runtime/0.9.2/0123456789ab/node/bin/node", "/Users/dana/profiles/other/runtime/0.9.2/0123456789ab/daemon/dist/index.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: foreign, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana", "/Users/dana/profiles/work") }))
      .resolves.toEqual({ installed: true })
    const later = vi.fn(async () => plist("/opt/homebrew/bin/node", "/Users/dana/.domovoi/runtime/0.9.2/0123456789ab/node/bin/node"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: later, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }))
      .resolves.toEqual({ installed: true })
    const staged = vi.fn(async () => plist("/Users/dana/.domovoi/runtime/0.9.2/0123456789ab/node/bin/node", "/Users/dana/.domovoi/runtime/0.9.2/0123456789ab/daemon/dist/index.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: staged, capture: vi.fn(), readConfiguration: vi.fn(() => undefined) }))
      .resolves.toEqual({ installed: true })
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: staged, capture: vi.fn(), readConfiguration: vi.fn(() => { throw new Error("not a configuration") }) }))
      .resolves.toEqual({ installed: true })
  })

  // Round 7: each publish is a fresh <version>/<id> directory; a runtime
  // path without that id is not one the desktop staged.
  it("reports no version for a runtime path without the publish id", async () => {
    const unstaged = vi.fn(async () => plist("/Users/dana/.domovoi/runtime/0.9.2/node/bin/node", "/Users/dana/.domovoi/runtime/0.9.2/daemon/dist/index.js"))
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: unstaged, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }))
      .resolves.toEqual({ installed: true })
  })

  // Round 8 (P3): the reader takes a version only when the desktop would
  // publish under it (isLoginServiceRuntimeVersion).
  it("reports no version for a folder name the desktop would never publish under", async () => {
    for (const version of ["0.9.2-..", "01.2.3", "0.9.2+", `0.9.2-${"a".repeat(64)}`]) {
      const copy = `/Users/dana/.domovoi/runtime/${version}/0123456789ab`
      const readDefinition = vi.fn(async () => plist(`${copy}/node/bin/node`, `${copy}/daemon/dist/index.js`))
      await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }), version)
        .resolves.toEqual({ installed: true })
    }
  })

  // Round 8 (P2): the daemon entry the definition runs must be the one in the
  // same published copy as its Node program, on every platform.
  it("reports no version when the daemon entry is not in the same copy as the Node program", async () => {
    const copy = "/Users/dana/.domovoi/runtime/0.9.2/0123456789ab"
    for (const entry of [
      "/Users/dana/profiles/other/runtime/0.9.2/0123456789ab/daemon/dist/index.js",
      "/Users/dana/.domovoi/runtime/0.9.1/0123456789ab/daemon/dist/index.js",
      "/Users/dana/.domovoi/runtime/0.9.2/ba9876543210/daemon/dist/index.js",
      `${copy}/daemon/dist/other.js`,
      `${copy}/daemon/dist/../../../ba9876543210/daemon/dist/index.js`,
      "/tmp/entry.js",
    ]) {
      const readDefinition = vi.fn(async () => plist(`${copy}/node/bin/node`, entry))
      await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }), entry)
        .resolves.toEqual({ installed: true })
    }
    const programOnly = vi.fn(async () => `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>${copy}/node/bin/node</string></array></dict></plist>`)
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: programOnly, capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }))
      .resolves.toEqual({ installed: true })
    const unit = "[Service]\nExecStart=\"/home/dana/.domovoi/runtime/0.9.2/0123456789ab/node/bin/node\" \"/home/dana/.domovoi/runtime/0.9.1/0123456789ab/daemon/dist/index.js\" --service-config x\n"
    await expect(readDaemonServiceRuntimeVersion({ platform: "linux", home: "/home/dana", readDefinition: async () => unit, capture: vi.fn(), readConfiguration: saved("linux", "/home/dana") }))
      .resolves.toEqual({ installed: true })
    const xml = "<Task><Actions><Exec><Command>\"C:\\Users\\dana\\.domovoi\\runtime\\0.9.2\\0123456789ab\\node\\node.exe\"</Command><Arguments>\"C:\\Users\\dana\\profiles\\other\\runtime\\0.9.2\\0123456789ab\\daemon\\dist\\index.js\" --service-config \"C:\\Users\\dana\\.domovoi\\service.json\"</Arguments></Exec></Actions></Task>"
    await expect(readDaemonServiceRuntimeVersion({ platform: "win32", home: "C:\\Users\\dana", readDefinition: vi.fn(), capture: vi.fn(async () => ({ code: 0, stdout: xml })), readConfiguration: saved("win32", "C:\\Users\\dana") }))
      .resolves.toEqual({ installed: true })
  })

  it("says installed with no version when the service runs a runtime the desktop did not stage", async () => {
    await expect(readDaemonServiceRuntimeVersion({ platform: "darwin", home: "/Users/dana", readDefinition: async () => plist("/opt/homebrew/bin/node", "/opt/homebrew/lib/node_modules/@getdomovoi/daemon/dist/index.js"), capture: vi.fn(), readConfiguration: saved("darwin", "/Users/dana") }))
      .resolves.toEqual({ installed: true })
  })

  it("says not installed when there is no definition", async () => {
    await expect(readDaemonServiceRuntimeVersion({ platform: "linux", home: "/home/dana", readDefinition: async () => undefined, capture: vi.fn(), readConfiguration: vi.fn() }))
      .resolves.toEqual({ installed: false })
    await expect(readDaemonServiceRuntimeVersion({ platform: "win32", home: "C:\\Users\\dana", readDefinition: vi.fn(), capture: vi.fn(async () => ({ code: 1, stdout: "" })), readConfiguration: vi.fn() }))
      .resolves.toEqual({ installed: false })
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
  // A bootout that unloads the job and still reports failure.
  bootoutUnloadsThenFails?: boolean
  // A foreign job that takes the label when the failing command fails.
  foreignLoadsOnFailure?: string
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
        if (start.foreignLoadsOnFailure) job = { path: start.foreignLoadsOnFailure, running: true }
        throw new Error(`${line} failed`)
      }
      if (args[0] === "/create") task = { path: `"${args[args.indexOf("/tr") + 1]!.split('" "')[0]!.slice(1)}"`, arguments: args[args.indexOf("/tr") + 1]!.split('" ').slice(1).join('" ') }
      if (args[0] === "bootout") {
        job = undefined
        if (start.bootoutUnloadsThenFails) throw new Error("Boot-out failed: 5: Input/output error")
      }
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

// Security review round 5: a bootout can report failure after it unloaded the
// job. The install then fails, and the previous agent must be loaded again.
describe("security review round 5 (install)", () => {
  const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  const configuration = "/Users/dl/.domovoi/service.json"

  it("loads the previous launch agent again when a failed bootout unloaded it", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, job: { path: agent, running: false }, bootoutUnloadsThenFails: true })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow("Boot-out failed")
    expect(Object.fromEntries(fake.files)).toEqual({ [agent]: "old agent", [configuration]: "old configuration" })
    expect(fake.job()?.path).toBe(agent)
    expect(fake.ran).toEqual(["launchctl bootout", "launchctl bootstrap"])
  })

  it("leaves a job a failed bootout did not unload as it was", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, job: { path: agent, running: false }, failing: "bootout" })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow("launchctl bootout failed")
    expect(fake.job()).toEqual({ path: agent, running: false })
    expect(fake.ran).toEqual(["launchctl bootout"])
  })
})

// Security review round 5: systemd expands $ variables and % specifiers in
// ExecStart, and whether it undoes the doubling in the executable slot is not
// certain, so a Linux path with either is refused.
describe("security review round 5 (systemd paths)", () => {
  it("refuses $ or % in any path the unit runs, before the handoff", async () => {
    for (const [runtimePaths, home, character] of [
      [{ ...runtime, nodePath: "/opt/do$main/node" }, "/home/dl", "$"],
      [{ ...runtime, daemonEntryPath: "/opt/domovoi/%h/index.js" }, "/home/dl", "%"],
      [runtime, "/home/d$l", "$"],
      [runtime, "/home/d%l", "%"],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = dependencies({ platform: "linux", home })
      const refused = installDaemonService({ runtime: runtimePaths, releaseInAppDaemon }, effects)
      await expect(refused).rejects.toBeInstanceOf(SystemdPathCharacterError)
      await expect(refused).rejects.toThrow(`contains ${character}`)
      expect(releaseInAppDaemon).not.toHaveBeenCalled()
      expect(effects.claimServiceOperation).not.toHaveBeenCalled()
      expect(effects.write).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    }
  })
})

// Security review round 6: a job listed under the label after the install
// failed is Domovoi's previous agent only when it came from Domovoi's plist.
describe("security review round 6 (install)", () => {
  const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  const configuration = "/Users/dl/.domovoi/service.json"
  const other = "/Users/dl/Library/LaunchAgents/other.plist"

  it("says the previous agent could not be loaded again when a foreign job took the label", async () => {
    const fake = managerFake("darwin", { files: { [agent]: "old agent", [configuration]: "old configuration" }, job: { path: agent, running: false }, failing: "bootstrap", foreignLoadsOnFailure: other })
    await expect(installDaemonService({ runtime }, fake.effects)).rejects.toThrow(
      `launchctl bootstrap failed. Putting back the previous service files also failed: A job named sh.domovoi.domovoid is loaded from ${other}, which is not Domovoi's launch agent.`,
    )
    expect(fake.job()).toEqual({ path: other, running: true })
    expect(fake.ran).toEqual(["launchctl bootout", "launchctl bootstrap"])
  })
})

// Security review round 2 of #577 (P1): given the caller's environment, install
// and removal check the saved service's profile again under the
// service-operation lease, before the handoff and before any manager action.
describe("installDaemonService and removeDaemonService for the caller's profile", () => {
  const plistPath = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  // The removal snapshot is the one read of service.json a removal acts on.
  const savedFor = (profileDirectory: string) => vi.fn(() => ({ owner: undefined, configurationDigest: "digest", profileDirectory, effectiveProfileDirectory: profileDirectory }))
  const noDefinition = vi.fn(async (path: string) => path !== plistPath)
  // launchd with nothing of Domovoi's loaded: the label is not found and the
  // domain lists no sh.domovoi job. Round 4 checks both.
  const domain = (labels: string[] = []) => `gui/501 = {\n\tservices = {\n\t\t       0      -  \tcom.apple.example\n${labels.map((label) => `\t\t     812      0  \t${label}\n`).join("")}\t}\n}\n`
  const launchd = (options: { loaded?: boolean; labels?: string[] } = {}) => vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === "gui/501/sh.domovoi.domovoid") {
      return options.loaded
        ? { code: 0, stdout: "\tstate = running\n" }
        : { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
    }
    if (args[1] === "gui/501") return { code: 0, stdout: domain(options.labels) }
    throw new Error(`unexpected capture ${args.join(" ")}`)
  })

  it("installs for the caller's profile and records it", async () => {
    // No service saved and no launch agent registered: nothing to bind to.
    const effects = dependencies({ exists: noDefinition, capture: launchd() })
    await installDaemonService({ runtime, environment: { DOMOVOI_PROFILE_DIR: "/Users/dl/profiles/work" } }, effects)
    const written = vi.mocked(effects.write).mock.calls.find(([path]) => path === "/Users/dl/.domovoi/service.json")![1]
    expect(parseServiceConfiguration(written).profileDirectory).toBe("/Users/dl/profiles/work")
  })

  it("refuses an install over a service saved for another profile, before the handoff", async () => {
    const releaseInAppDaemon = vi.fn(async () => {})
    const effects = dependencies({ registeredProfile: vi.fn(() => ({ profileDirectory: "/Users/dl/profiles/other" })) })
    const refused = installDaemonService({ runtime, environment: {}, releaseInAppDaemon }, effects)
    await expect(refused).rejects.toBeInstanceOf(ServiceProfileMismatchError)
    await expect(refused).rejects.toThrow("This app's daemon uses the profile at /Users/dl/.domovoi, and the login service uses the profile at /Users/dl/profiles/other.")
    expect(effects.claimServiceOperation).toHaveBeenCalled()
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("refuses a removal of a service saved for another profile, before any manager action", async () => {
    const effects = dependencies({ removalSnapshot: savedFor("/Users/dl/profiles/other") })
    await expect(removeDaemonService(effects, { environment: {} })).rejects.toBeInstanceOf(ServiceProfileMismatchError)
    expect(effects.claimServiceOperation).toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
  })

  it("removes a service saved for the caller's profile", async () => {
    const effects = dependencies({ removalSnapshot: savedFor("/Users/dl/profiles/other") })
    await expect(removeDaemonService(effects, { environment: { DOMOVOI_PROFILE_DIR: "/Users/dl/profiles/other" } })).resolves.toMatchObject({ kind: "file" })
    expect(effects.run).toHaveBeenCalledWith("launchctl", ["bootout", "gui/501/sh.domovoi.domovoid"], expect.anything())
  })

  // Security review round 3 of #577 (P1): with service.json gone, a launch
  // agent or user unit that is still registered runs a profile nothing names.
  // Given the caller's profile, the install and the removal refuse rather
  // than take it for the caller's. The definition names only service.json,
  // so the profile cannot be read from it.
  it("refuses an install over a registered service whose saved configuration is missing, before the handoff", async () => {
    const releaseInAppDaemon = vi.fn(async () => {})
    const effects = dependencies()
    const refused = installDaemonService({ runtime, environment: {}, releaseInAppDaemon }, effects)
    await expect(refused).rejects.toBeInstanceOf(ServiceProfileUnknownError)
    await expect(refused).rejects.toThrow(`A login service is registered at ${plistPath}, but its saved configuration is missing, so the profile it runs is not known. Nothing was changed.`)
    expect(releaseInAppDaemon).not.toHaveBeenCalled()
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("still lets the command line install over such a service, as before", async () => {
    await expect(installDaemonService({ runtime }, dependencies())).resolves.toMatchObject({ kind: "file" })
  })

  it("refuses a removal of a registered service whose saved configuration is missing or unreadable, before any manager action", async () => {
    const missing = dependencies()
    await expect(removeDaemonService(missing, { environment: {} })).rejects.toBeInstanceOf(ServiceProfileUnknownError)
    expect(missing.run).not.toHaveBeenCalled()
    const unreadable = dependencies({ removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: "digest", configurationUnknown: "The saved service configuration at /Users/dl/.domovoi/service.json is not a Domovoi service configuration." })) })
    const refused = removeDaemonService(unreadable, { environment: {} })
    await expect(refused).rejects.toBeInstanceOf(ServiceProfileUnknownError)
    await expect(refused).rejects.toThrow("The saved service configuration at /Users/dl/.domovoi/service.json is not a Domovoi service configuration. The profile the login service runs is not known. Nothing was changed.")
    expect(unreadable.run).not.toHaveBeenCalled()
  })

  // Security review round 3 of #577 (P2): the removal checks the same read of
  // service.json it then acts on, not a separate earlier read.
  it("checks the profile in the snapshot the removal acts on", async () => {
    const other = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: "/Users/dl/profiles/other" }, { platform: "darwin", homeDirectory: "/Users/dl", workingDirectory: "/Users/dl" })
    const effects = dependencies({
      readConfiguration: vi.fn(() => other),
      removalSnapshot: savedFor("/Users/dl/profiles/replaced"),
    })
    await expect(removeDaemonService(effects, { environment: { DOMOVOI_PROFILE_DIR: "/Users/dl/profiles/other" } })).rejects.toBeInstanceOf(ServiceProfileMismatchError)
    expect(effects.run).not.toHaveBeenCalled()
  })

  // Security review round 4 of #577 (P1): the guard reads what the manager
  // has registered, not only the definition file. A job still loaded after
  // its plist was deleted, or a Domovoi job under another label, runs a
  // profile nothing names.
  it("refuses an install while a Domovoi job is loaded with its plist gone, or under another label, before the handoff", async () => {
    for (const [label, capture, where] of [
      ["the job is loaded", launchd({ loaded: true }), "gui/501/sh.domovoi.domovoid"],
      ["another label", launchd({ labels: ["sh.domovoi.domovoid-old"] }), "gui/501/sh.domovoi.domovoid-old"],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = dependencies({ exists: noDefinition, capture })
      const refused = installDaemonService({ runtime, environment: {}, releaseInAppDaemon }, effects)
      await expect(refused, label).rejects.toBeInstanceOf(ServiceProfileUnknownError)
      await expect(refused, label).rejects.toThrow(`A login service is registered at ${where}, but its saved configuration is missing, so the profile it runs is not known. Nothing was changed.`)
      expect(releaseInAppDaemon, label).not.toHaveBeenCalled()
      expect(effects.write, label).not.toHaveBeenCalled()
      expect(effects.run, label).not.toHaveBeenCalled()
    }
  })

  it("refuses an install while a Domovoi user unit is loaded with its unit file gone", async () => {
    const unit = "/home/dl/.config/systemd/user/domovoid.service"
    const effects = dependencies({
      platform: "linux", home: "/home/dl",
      exists: vi.fn(async (path: string) => path !== unit),
      capture: vi.fn(async (_command: string, args: string[]) => args.includes("list-units")
        ? { code: 0, stdout: "domovoid.service not-found active running domovoid.service\n" }
        : { code: 0, stdout: "" }),
    })
    await expect(installDaemonService({ runtime, environment: {} }, effects)).rejects.toThrow(
      "A login service is registered at domovoid.service, but its saved configuration is missing, so the profile it runs is not known. Nothing was changed.",
    )
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.run).not.toHaveBeenCalled()
  })

  it("refuses a removal while a Domovoi job is loaded with its plist gone, before any manager action", async () => {
    const effects = dependencies({ exists: noDefinition, capture: launchd({ loaded: true }) })
    await expect(removeDaemonService(effects, { environment: {} })).rejects.toBeInstanceOf(ServiceProfileUnknownError)
    expect(effects.run).not.toHaveBeenCalled()
  })

  // Round 4 (P1): a legacy configuration names its own home; its default
  // profile is under that home, not the caller's.
  it("compares the removal with the profile the saved configuration names under its own home", async () => {
    const effects = dependencies({ removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: "digest", effectiveProfileDirectory: "/Users/other/.domovoi" })) })
    await expect(removeDaemonService(effects, { environment: {} })).rejects.toBeInstanceOf(ServiceProfileMismatchError)
    expect(effects.run).not.toHaveBeenCalled()
  })

  // Round 4 (P3): a saved configuration that cannot be read or parsed
  // refuses the caller's install with the specific refusal.
  it("refuses an install over a saved configuration it cannot read or parse, with nothing written", async () => {
    for (const [label, failure, words] of [
      ["a link", Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" }), "The saved service configuration at /Users/dl/.domovoi/service.json could not be read: ELOOP: too many symbolic links. The profile the login service runs is not known. Nothing was changed."],
      ["malformed", new Error("Unexpected token"), "The saved service configuration at /Users/dl/.domovoi/service.json is not a Domovoi service configuration. The profile the login service runs is not known. Nothing was changed."],
    ] as const) {
      const releaseInAppDaemon = vi.fn(async () => {})
      const effects = dependencies({ registeredProfile: vi.fn(() => { throw failure }) })
      const refused = installDaemonService({ runtime, environment: {}, releaseInAppDaemon }, effects)
      await expect(refused, label).rejects.toBeInstanceOf(ServiceProfileUnknownError)
      await expect(refused, label).rejects.toThrow(words)
      expect(releaseInAppDaemon, label).not.toHaveBeenCalled()
      expect(effects.write, label).not.toHaveBeenCalled()
    }
  })

  // Security review round 4 of #577 (P2): the desktop hands over an inert
  // staged copy and a publish step. The install checks the staged files,
  // then publishes only under the service-operation lease, after every
  // profile check and before the handoff.
  it("publishes the staged runtime only after the profile checks, under the lease, before the handoff", async () => {
    const order: string[] = []
    const staged = { nodePath: "/Users/dl/.domovoi/runtime/.0.9.4.staging-1/node/bin/node", daemonEntryPath: "/Users/dl/.domovoi/runtime/.0.9.4.staging-1/daemon/dist/index.js" }
    const publish = vi.fn(async () => { order.push("publish") })
    const effects = dependencies({
      exists: noDefinition, capture: launchd(),
      claimServiceOperation: vi.fn(() => { order.push("lease"); return { release: vi.fn() } }),
      runtimeFile: vi.fn(async (path: string) => { order.push(`check ${path === staged.nodePath || path === staged.daemonEntryPath ? "staged" : "published"}`); return "file" as const }),
    })
    await installDaemonService({ runtime, staged: { runtime: staged, publish }, environment: {}, releaseInAppDaemon: async () => { order.push("handoff") } }, effects)
    // Round 5 (P1): the handoff and its checks refuse before anything is
    // published; the profile is claimed for the service, then it goes in.
    expect(order).toEqual(["check staged", "check staged", "lease", "handoff", "publish", "check published", "check published"])

    const refused = dependencies({ registeredProfile: vi.fn(() => ({ profileDirectory: "/Users/dl/profiles/other" })) })
    const notPublished = vi.fn(async () => {})
    await expect(installDaemonService({ runtime, staged: { runtime: staged, publish: notPublished }, environment: {} }, refused)).rejects.toBeInstanceOf(ServiceProfileMismatchError)
    expect(notPublished).not.toHaveBeenCalled()
  })

  // Security review round 5 of #577 (P1): the domain listing is read by its
  // services block, label last, whatever columns come between. A listing
  // this cannot read refuses rather than pass as having no Domovoi job.
  it("finds a Domovoi label in a listing with an extra column, and refuses a listing it cannot read", async () => {
    const listing = (stdout: string) => vi.fn(async (_command: string, args: string[]) => args[1] === "gui/501/sh.domovoi.domovoid"
      ? { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
      : { code: 0, stdout })
    const extraColumn = "gui/501 = {\n\tservices = {\n\t\t       0      -      -  \tcom.apple.example\n\t\t     812      0      2  \tsh.domovoi.domovoid-old\n\t}\n}\n"
    const found = dependencies({ exists: noDefinition, capture: listing(extraColumn) })
    await expect(installDaemonService({ runtime, environment: {} }, found)).rejects.toThrow(
      "A login service is registered at gui/501/sh.domovoi.domovoid-old, but its saved configuration is missing, so the profile it runs is not known. Nothing was changed.",
    )
    expect(found.write).not.toHaveBeenCalled()
    for (const [label, stdout] of [
      ["no services block", "gui/501 = {\n\tjobs: com.apple.example sh.domovoi.domovoid-old\n}\n"],
      ["a line it cannot read", "gui/501 = {\n\tservices = {\n\t\tsh.domovoi.domovoid-old\n\t}\n}\n"],
    ] as const) {
      const unreadable = dependencies({ exists: noDefinition, capture: listing(stdout) })
      const refused = installDaemonService({ runtime, environment: {} }, unreadable)
      await expect(refused, label).rejects.toBeInstanceOf(ServiceProfileUnknownError)
      await expect(refused, label).rejects.toThrow("launchd listed the jobs in gui/501 in a form this app cannot read, so whether a login service is registered there is not known. Nothing was changed.")
      expect(unreadable.write, label).not.toHaveBeenCalled()
      const removal = dependencies({ exists: noDefinition, capture: listing(stdout) })
      await expect(removeDaemonService(removal, { environment: {} }), label).rejects.toBeInstanceOf(ServiceProfileUnknownError)
      expect(removal.run, label).not.toHaveBeenCalled()
    }
  })

  // Security review round 6 of #577 (P1): the whole domain must be there and
  // well formed, and a row naming Domovoi anywhere but as its one label is
  // ambiguous. Both refuse rather than pass as having no Domovoi job.
  it("refuses a truncated domain listing and a row whose Domovoi label is ambiguous", async () => {
    const listing = (stdout: string) => vi.fn(async (_command: string, args: string[]) => args[1] === "gui/501/sh.domovoi.domovoid"
      ? { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
      : { code: 0, stdout })
    for (const [label, stdout] of [
      ["the domain never closes", "gui/501 = {\n\tservices = {\n\t\t       0      -  \tcom.apple.example\n\t}\n"],
      ["the services block never closes", "gui/501 = {\n\tservices = {\n\t\t       0      -  \tcom.apple.example\n"],
      ["another domain", "gui/502 = {\n\tservices = {\n\t\t       0      -  \tcom.apple.example\n\t}\n}\n"],
      ["a label with a space", "gui/501 = {\n\tservices = {\n\t\t     812      0  \tsh.domovoi.domovoid old\n\t}\n}\n"],
      ["Domovoi before the last field", "gui/501 = {\n\tservices = {\n\t\t     812      0  \tsh.domovoi.domovoid\tcom.apple.example\n\t}\n}\n"],
    ] as const) {
      const effects = dependencies({ exists: noDefinition, capture: listing(stdout) })
      const refused = installDaemonService({ runtime, environment: {} }, effects)
      await expect(refused, label).rejects.toBeInstanceOf(ServiceProfileUnknownError)
      await expect(refused, label).rejects.toThrow("launchd listed the jobs in gui/501 in a form this app cannot read, so whether a login service is registered there is not known. Nothing was changed.")
      expect(effects.write, label).not.toHaveBeenCalled()
      expect(effects.run, label).not.toHaveBeenCalled()
    }
  })

  // Security review round 5 of #577 (P1): every refusal comes before the
  // publish: the handoff's own profile check, the caller's fence (thrown from
  // the handoff), and the claim of the profile for the service.
  it("publishes nothing when the handoff, its profile check or the profile claim refuses", async () => {
    const staged = { nodePath: "/Users/dl/.domovoi/runtime/.0.9.4.staging-1/node/bin/node", daemonEntryPath: "/Users/dl/.domovoi/runtime/.0.9.4.staging-1/daemon/dist/index.js" }
    const owned = new ProfileAlreadyOwnedError("/Users/dl/.domovoi/profile-lease.sqlite")
    for (const [label, overrides, releaseInAppDaemon] of [
      ["the fence refuses", {}, async () => { throw new Error("1 turn is running (Fix login).") }],
      ["the handoff check refuses", { claimProfile: vi.fn(() => { throw owned }), readOwner: vi.fn(() => undefined) }, async () => {}],
      ["the claim after the handoff fails", { claimProfile: vi.fn().mockReturnValueOnce({ release: vi.fn() }).mockImplementation(() => { throw owned }) }, async () => {}],
    ] as const) {
      const publish = vi.fn(async () => {})
      const effects = dependencies({ exists: noDefinition, capture: launchd(), ...overrides })
      await expect(installDaemonService({ runtime, staged: { runtime: staged, publish }, environment: {}, releaseInAppDaemon }, effects), label).rejects.toThrow()
      expect(publish, label).not.toHaveBeenCalled()
      expect(effects.write, label).not.toHaveBeenCalled()
    }
  })

  // Security review round 5 of #577 (P2): the removal leases, and writes any
  // recovery receipt into, the profile the saved configuration names under
  // its own home, the one it checked, not the caller's home profile.
  it("leases and records recovery in the effective profile it checked", async () => {
    const claimProfile = vi.fn(() => ({ release: vi.fn() }))
    const effects = dependencies({
      claimProfile,
      removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: "digest", effectiveProfileDirectory: "/Users/other/.domovoi" })),
    })
    await removeDaemonService(effects, { environment: { DOMOVOI_PROFILE_DIR: "/Users/other/.domovoi" } })
    expect(claimProfile).toHaveBeenCalledWith({ profileDirectory: "/Users/other/.domovoi" })
  })
})

// Security review round 6 of #577 (P1): once the staged runtime is published,
// every later failure of the install puts the previous copy of that version
// back. The fake staged copy models the version in place.
describe("installDaemonService leaves every runtime copy alone on every failure after the publish (round 7)", () => {
  const staged = { nodePath: "/stage/node/bin/node", daemonEntryPath: "/stage/daemon/dist/index.js" }
  const plistPath = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
  const missingJob = vi.fn(async (_command: string, args: string[]) => args[1] === "gui/501/sh.domovoi.domovoid"
    ? { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
    : { code: 0, stdout: "gui/501 = {\n\tservices = {\n\t\t       0      -  \tcom.apple.example\n\t}\n}\n" })
  function versioned() {
    const state = { version: "old" }
    return { state, staged: { runtime: staged, publish: vi.fn(async () => { state.version = "new" }), revert: vi.fn(async () => { state.version = "old" }) } }
  }
  const cases: [string, (state: { version: string }) => Partial<DaemonServiceDependencies & ServiceEffects>][] = [
    ["the published runtime fails its check", (state) => ({ runtimeFile: vi.fn(async (path: string) => path === runtime.nodePath && state.version === "new" ? "missing" as const : "file" as const) })],
    ["the old recovery receipt cannot be removed", () => ({ remove: vi.fn(async () => { throw new Error("remove failed") }) })],
    ["service.json cannot be written", () => ({ write: vi.fn(async (path: string) => { if (path.endsWith("service.json")) throw new Error("write failed") }) })],
    ["the launch agent cannot be written", () => ({ write: vi.fn(async (path: string) => { if (path === plistPath) throw new Error("write failed") }) })],
    ["launchd refuses to load the agent", () => ({ run: vi.fn(async (_command: string, args: string[]) => { if (args[0] === "bootstrap") throw new Error("launchctl bootstrap exited 5") }) })],
  ]
  for (const [label, overrides] of cases) {
    it(`reverts nothing when ${label}`, async () => {
      const { state, staged: copy } = versioned()
      const effects = dependencies({ exists: vi.fn(async (path: string) => path !== plistPath), capture: missingJob, ...overrides(state) })
      await expect(installDaemonService({ runtime, staged: copy, environment: {} }, effects)).rejects.toThrow()
      expect(copy.publish).toHaveBeenCalledOnce()
      // Round 7: the publish wrote a fresh directory the previous service
      // never used, so nothing is put back and no shared copy was replaced.
      expect(copy.revert).not.toHaveBeenCalled()
      expect(state.version).toBe("new")
    })
  }

  it("keeps the new runtime when the install succeeds, and never reverts what it did not publish", async () => {
    const done = versioned()
    await installDaemonService({ runtime, staged: done.staged, environment: {} }, dependencies({ exists: vi.fn(async (path: string) => path !== plistPath), capture: missingJob }))
    expect(done.staged.revert).not.toHaveBeenCalled()
    expect(done.state.version).toBe("new")
    const refused = versioned()
    await expect(installDaemonService({ runtime, staged: refused.staged, environment: {}, releaseInAppDaemon: async () => { throw new Error("1 turn is running (Fix login).") } }, dependencies({ exists: vi.fn(async (path: string) => path !== plistPath), capture: missingJob }))).rejects.toThrow()
    expect(refused.staged.publish).not.toHaveBeenCalled()
    expect(refused.staged.revert).not.toHaveBeenCalled()
  })
})

// Security review round 7 of #577 (P1): a service that fails to start after
// its definition was registered keeps that definition, and the runtime it
// names stays in place. Round 6 reverted the runtime there, leaving a
// registered service whose runtime was gone.
describe("installDaemonService keeps the runtime a registered definition names", () => {
  const staged = { nodePath: "/stage/node/bin/node", daemonEntryPath: "/stage/daemon/dist/index.js" }
  const unit = "/home/dl/.config/systemd/user/domovoid.service"
  it("keeps the published runtime when systemd registers the unit and then fails to start it", async () => {
    const state = { version: "old" }
    const copy = { runtime: staged, publish: vi.fn(async () => { state.version = "new" }), revert: vi.fn(async () => { state.version = "old" }) }
    const written = new Map<string, string>()
    const effects = dependencies({
      platform: "linux", home: "/home/dl",
      exists: vi.fn(async (path: string) => path !== unit),
      capture: vi.fn(async () => ({ code: 0, stdout: "" })),
      write: vi.fn(async (path: string, contents: string) => { written.set(path, contents) }),
      run: vi.fn(async (_command: string, args: string[]) => { if (args.includes("enable")) throw new Error("systemctl enable exited 1") }),
    })
    await expect(installDaemonService({ runtime, staged: copy, environment: {} }, effects)).rejects.toThrow("systemctl enable exited 1")
    expect(written.get(unit)).toContain(runtime.nodePath)
    expect(copy.revert).not.toHaveBeenCalled()
    expect(state.version).toBe("new")
  })
})

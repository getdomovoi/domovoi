import { describe, expect, it, vi } from "vitest"

import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  installDaemonService,
  readDaemonServiceStatus,
  removeDaemonService,
  type DaemonServiceDependencies,
} from "../public.js"
import { parseServiceConfiguration } from "./configuration.js"
import type { ServiceEffects } from "./install.js"

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

  // Ruled 2026-09-24 (A): the install records the runtime and daemon entry it
  // installed in its own service.json; an update's rollback starts only those.
  it("records the installed runtime and daemon entry in service.json on every platform", async () => {
    const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\index.js" }
    for (const [platform, home, shipped] of [
      ["darwin", "/Users/dl", runtime],
      ["linux", "/home/dl", runtime],
      ["win32", "C:\\Users\\dl", windowsRuntime],
    ] as const) {
      const effects = dependencies({ platform, home })
      const installed = await installDaemonService({ runtime: shipped }, effects)
      const written = vi.mocked(effects.write).mock.calls.find(([path]) => path === installed.configurationPath)![1]
      expect(parseServiceConfiguration(written).serviceRuntime).toEqual({ executable: shipped.nodePath, entry: shipped.daemonEntryPath })
    }
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

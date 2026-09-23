import { describe, expect, it, vi } from "vitest"

import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  installDaemonService,
  readDaemonServiceStatus,
  removeDaemonService,
  type DaemonServiceDependencies,
} from "../public.js"
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

  it("runs a Windows logon task through the shipped node.exe", async () => {
    const effects = dependencies({ platform: "win32", home: "C:\\Users\\dl", user: "dl" })
    const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime\\daemon\\index.js" }
    expect(await installDaemonService({ runtime: windowsRuntime }, effects)).toMatchObject({ kind: "task", name: "Domovoi daemon" })
    const created = vi.mocked(effects.run).mock.calls.find(([, args]) => args[0] === "/create")![1]
    expect(created[created.indexOf("/tr") + 1]).toMatch(/^"C:\\Program Files\\Domovoi\\runtime\\node\.exe" "C:\\Program Files\\Domovoi\\runtime\\daemon\\index\.js" --service-config /)
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

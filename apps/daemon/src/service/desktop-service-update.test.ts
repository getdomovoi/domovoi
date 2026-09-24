import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  DaemonServiceUpdateError,
  updateDaemonService,
  type DaemonServiceDependencies,
} from "../public.js"
import { createServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import type { CapturedRun, ServiceEffects } from "./install.js"
import { installedWslTask } from "./wsl-registration.js"

// Ruled 2026-09-23: "Update the service" swaps the running service to the
// runtime the app now ships, in place, on each platform. Nothing here runs a
// real launchctl, systemctl, schtasks, PowerShell or wsl.exe: every service
// manager is a fake that records what it was asked, in order.

const oldRuntime = {
  nodePath: "/Applications/Domovoi.app/Contents/Resources/runtime-1/node",
  daemonEntryPath: "/Applications/Domovoi.app/Contents/Resources/runtime-1/daemon/dist/index.js",
}
const runtime = {
  nodePath: "/Applications/Domovoi.app/Contents/Resources/runtime-2/node",
  daemonEntryPath: "/Applications/Domovoi.app/Contents/Resources/runtime-2/daemon/dist/index.js",
}
const agent = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"
const unit = "/home/dl/.config/systemd/user/domovoid.service"

type Fake = DaemonServiceDependencies & ServiceEffects & { order: string[] }

function saved(platform: string, home: string): ServiceConfiguration {
  return { ...createServiceConfiguration({}, { platform, homeDirectory: home, workingDirectory: home }), registrationId: "5b7b2f0e-1111-4222-8333-444455556666" }
}

// The PowerShell a Task Scheduler step runs, decoded, so a fake can answer it.
function script(args: readonly string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1]
  return encoded === undefined ? "" : Buffer.from(encoded, "base64").toString("utf16le")
}

// null: no saved service configuration, as when no service is installed.
function fake(platform: string, home: string, overrides: Partial<Fake> = {}, configuration: ServiceConfiguration | null = saved(platform, home)): Fake {
  const order: string[] = []
  const files = new Map<string, string>([
    [agent, `<plist>${oldRuntime.nodePath}</plist>`],
    [unit, `[Service]\nExecStart=${oldRuntime.nodePath}\n`],
  ])
  const record = (entry: string) => { order.push(entry) }
  const effects: Fake = {
    order,
    platform,
    home,
    uid: 501,
    user: "dl",
    profileReleaseWaitMs: 0,
    runtimeFile: vi.fn(async () => "file" as const),
    readConfiguration: vi.fn(() => configuration ?? undefined),
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => { record("claim"); return { release: vi.fn(() => { record("release") }) } }),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    read: vi.fn(async (path: string) => {
      const contents = files.get(path)
      if (contents === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      return contents
    }),
    write: vi.fn(async (path: string, contents: string) => { record(`write ${path}`); files.set(path, contents) }),
    run: vi.fn(async (command: string, args: string[]) => { record(`${command} ${args.join(" ")}`) }),
    capture: vi.fn(async (command: string, args: string[]): Promise<CapturedRun> => {
      const body = script(args)
      if (body.includes("domovoi-task-action")) {
        record("read task action")
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ path: "C:\\Program Files\\Domovoi\\runtime-1\\node.exe", arguments: "\"C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js\" --service-config \"C:\\Users\\dl\\.domovoi\\service.json\"" })}\n` }
      }
      if (body.includes("DeleteTask")) { record("delete task"); return { code: 0, stdout: "domovoi-task:deleted\n" } }
      if (body.includes("$task.Stop(0)")) { record("stop task"); return { code: 0, stdout: "domovoi-task:1\n" } }
      if (body.includes("$task.Enabled = $false")) { record("disable task"); return { code: 0, stdout: "domovoi-task:1\n" } }
      if (body.includes("RegisterTaskDefinition")) { record("register task"); return { code: 0, stdout: "domovoi-task:created\n" } }
      if (body.includes("$task.Run($null)")) { record("start task"); return { code: 0, stdout: "domovoi-task:4\n" } }
      record(`capture ${command} ${args.join(" ")}`)
      return { code: 0, stdout: "domovoi-task:1\n" }
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    remove: vi.fn(async (path: string) => { files.delete(path) }),
    stopSupervisor: vi.fn(async () => { record("stop guest supervisor") }),
    ...overrides,
  }
  return effects
}

beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
afterEach(() => { vi.unstubAllEnvs() })

describe("updateDaemonService before any change", () => {
  it("refuses a runtime that is not there, with the update's own words and nothing touched", async () => {
    const effects = fake("darwin", "/Users/dl", { runtimeFile: vi.fn(async (path: string) => path === runtime.nodePath ? "missing" as const : "file" as const) })
    const refused = updateDaemonService({ runtime }, effects)
    await expect(refused).rejects.toBeInstanceOf(DaemonServiceRuntimeMissingError)
    await expect(refused).rejects.toThrow(`The Node runtime this app ships was not found at ${runtime.nodePath}. The service was not updated and no service files were changed.`)
    expect(effects.order).toEqual([])
    expect(effects.readConfiguration).not.toHaveBeenCalled()
  })

  it("says there is nothing to update when no service is installed", async () => {
    const effects = fake("darwin", "/Users/dl", {}, null)
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "No Domovoi service is installed for this user, so there is nothing to update. Install the service first.",
    )
    await expect(updateDaemonService({ runtime }, effects)).rejects.toMatchObject({ outcome: "not-installed" })
    expect(effects.order).toEqual([])
  })
})

describe("updateDaemonService with launchd", () => {
  it("boots the agent out, holds the profile while it writes the new agent, then boots it in", async () => {
    const effects = fake("darwin", "/Users/dl")
    expect(await updateDaemonService({ runtime }, effects)).toEqual({ kind: "file", path: agent, configurationPath: "/Users/dl/.domovoi/service.json" })
    expect(effects.order).toEqual([
      "launchctl bootout gui/501/sh.domovoi.domovoid",
      "claim",
      `write ${agent}`,
      "release",
      `launchctl bootstrap gui/501 ${agent}`,
    ])
    const written = vi.mocked(effects.write).mock.calls.find(([path]) => path === agent)![1]
    expect(written).toContain(`<string>${runtime.nodePath}</string>`)
    expect(written).toContain(`<string>${runtime.daemonEntryPath}</string>`)
  })

  it("puts the previous agent back and running when the new one will not boot", async () => {
    const effects = fake("darwin", "/Users/dl")
    let bootstraps = 0
    effects.run = vi.fn(async (command: string, args: string[]) => {
      effects.order.push(`${command} ${args.join(" ")}`)
      if (args[0] === "bootstrap" && ++bootstraps === 1) throw new Error("Bootstrap failed: 5: Input/output error")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: Bootstrap failed: 5: Input/output error. The previous service was put back and is running.",
    )
    expect(effects.order.slice(-2)).toEqual([`write ${agent}`, `launchctl bootstrap gui/501 ${agent}`])
    expect(vi.mocked(effects.write).mock.calls.at(-1)![1]).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
  })

  it("says the service is not running when putting the previous agent back fails too", async () => {
    const effects = fake("darwin", "/Users/dl")
    effects.run = vi.fn(async (command: string, args: string[]) => {
      effects.order.push(`${command} ${args.join(" ")}`)
      if (args[0] === "bootstrap") throw new Error(effects.order.filter((entry) => entry.includes("bootstrap")).length === 1 ? "new agent refused" : "old agent refused")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: new agent refused. Putting the previous service back also failed: old agent refused. The service is not running. Check it with `domovoid service status`, then install it again.",
    )
  })

  it("puts the previous agent back when another daemon took the profile while it was stopped", async () => {
    const effects = fake("darwin", "/Users/dl", { claimProfile: vi.fn(() => { throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi") }) })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Another Domovoi daemon took this profile while the service was stopped for the update. The previous service was put back and is running.",
    )
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.order).toEqual(["launchctl bootout gui/501/sh.domovoi.domovoid", `launchctl bootstrap gui/501 ${agent}`])
  })

  it("keeps the saved service configuration as it is", async () => {
    const effects = fake("darwin", "/Users/dl")
    await updateDaemonService({ runtime }, effects)
    expect(vi.mocked(effects.write).mock.calls.map(([path]) => path)).toEqual([agent])
  })
})

describe("updateDaemonService with systemd", () => {
  it("writes the new unit, reloads and restarts, without claiming the profile the running daemon holds", async () => {
    const effects = fake("linux", "/home/dl")
    expect(await updateDaemonService({ runtime }, effects)).toEqual({ kind: "file", path: unit, configurationPath: "/home/dl/.domovoi/service.json" })
    expect(effects.order).toEqual([`write ${unit}`, "systemctl --user daemon-reload", "systemctl --user restart domovoid.service"])
    expect(effects.claimProfile).not.toHaveBeenCalled()
    expect(vi.mocked(effects.write).mock.calls[0]![1]).toContain(runtime.nodePath)
  })

  it("puts the previous unit back and restarts it when the restart fails", async () => {
    const effects = fake("linux", "/home/dl")
    let restarts = 0
    effects.run = vi.fn(async (command: string, args: string[]) => {
      effects.order.push(`${command} ${args.join(" ")}`)
      if (args[1] === "restart" && ++restarts === 1) throw new Error("Job for domovoid.service failed")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: Job for domovoid.service failed. The previous service was put back and is running.",
    )
    expect(effects.order.slice(-3)).toEqual([`write ${unit}`, "systemctl --user daemon-reload", "systemctl --user restart domovoid.service"])
    expect(vi.mocked(effects.write).mock.calls.at(-1)![1]).toBe(`[Service]\nExecStart=${oldRuntime.nodePath}\n`)
  })
})

describe("updateDaemonService with a Windows logon task", () => {
  const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime-2\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime-2\\daemon\\index.js" }

  it("stops the task, holds the profile, re-registers it with the new command and runs it", async () => {
    const effects = fake("win32", "C:\\Users\\dl")
    expect(await updateDaemonService({ runtime: windowsRuntime }, effects)).toMatchObject({ kind: "task", name: "Domovoi daemon" })
    const created = vi.mocked(effects.run).mock.calls.find(([, args]) => args[0] === "/create")![1]
    expect(created[created.indexOf("/tr") + 1]).toMatch(/^"C:\\Program Files\\Domovoi\\runtime-2\\node\.exe" "C:\\Program Files\\Domovoi\\runtime-2\\daemon\\index\.js" --service-config /)
    expect(created).toContain("/f")
    expect(effects.order.map((entry) => entry.split(" ").slice(0, 2).join(" "))).toEqual([
      "read task", "stop task", "claim", "release", "schtasks /create", "schtasks /run",
    ])
  })

  it("re-registers the previous command and runs it when the new task will not run", async () => {
    const effects = fake("win32", "C:\\Users\\dl")
    effects.run = vi.fn(async (command: string, args: string[]) => {
      effects.order.push(`${command} ${args[0]}`)
      if (args[0] === "/run" && effects.order.filter((entry) => entry.endsWith("/run")).length === 1) throw new Error("ERROR: Access is denied.")
    })
    await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: ERROR: Access is denied. The previous service was put back and is running.",
    )
    const restored = vi.mocked(effects.run).mock.calls.filter(([, args]) => args[0] === "/create").at(-1)![1]
    expect(restored[restored.indexOf("/tr") + 1]).toBe("\"C:\\Program Files\\Domovoi\\runtime-1\\node.exe\" \"C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js\" --service-config \"C:\\Users\\dl\\.domovoi\\service.json\"")
    expect(effects.order.slice(-2)).toEqual(["schtasks /create", "schtasks /run"])
  })

  it("says there is nothing to update when the task is not registered", async () => {
    const effects = fake("win32", "C:\\Users\\dl")
    effects.capture = vi.fn(async () => ({ code: 0, stdout: "domovoi-task:missing\n" }))
    await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toMatchObject({ outcome: "not-installed" })
    expect(effects.run).not.toHaveBeenCalled()
  })
})

describe("updateDaemonService with a WSL guest service (ruled B)", () => {
  function wslConfiguration(): ServiceConfiguration {
    return {
      ...saved("linux", "/home/dl"),
      wsl: {
        distribution: "Ubuntu", linuxUser: "dl", powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        wsl: "C:\\Windows\\System32\\wsl.exe", executable: oldRuntime.nodePath, args: [oldRuntime.daemonEntryPath],
      },
    }
  }

  it("retires the old guest task, holds the profile while saving the new runtime, then registers and starts the new task", async () => {
    const configuration = wslConfiguration()
    const effects = fake("linux", "/home/dl", {}, configuration)
    const next = installedWslTask({ ...configuration.wsl!, executable: runtime.nodePath, args: [runtime.daemonEntryPath] }, configuration.registrationId!, "/home/dl/.domovoi/service.json")
    expect(await updateDaemonService({ runtime }, effects)).toEqual({ kind: "task", name: next.name, configurationPath: "/home/dl/.domovoi/service.json" })
    expect(effects.order).toEqual([
      "disable task", "stop guest supervisor", "stop task", "delete task",
      "claim", "write /home/dl/.domovoi/service.json", "release",
      "register task", "start task",
    ])
    const written = JSON.parse(vi.mocked(effects.write).mock.calls[0]![1]) as ServiceConfiguration
    expect(written.wsl).toMatchObject({ executable: runtime.nodePath, args: [runtime.daemonEntryPath] })
    expect(written.registrationId).toBe(configuration.registrationId)
    const registered = vi.mocked(effects.capture).mock.calls.find(([, args]) => script(args).includes("RegisterTaskDefinition"))![1]
    expect(registered).toEqual(next.register.args)
  })

  it("registers the old task again with the old runtime saved when the new one will not register", async () => {
    const configuration = wslConfiguration()
    const effects = fake("linux", "/home/dl", {}, configuration)
    const capture = effects.capture
    let registrations = 0
    effects.capture = vi.fn(async (command: string, args: string[]) => {
      if (script(args).includes("RegisterTaskDefinition") && ++registrations === 1) {
        effects.order.push("register task refused")
        return { code: 1, stdout: "", stderr: "Access is denied" }
      }
      return capture(command, args, undefined as never)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      /^Domovoi could not start the service on the new runtime: .+\. The previous service was put back and is running\.$/,
    )
    expect(effects.order.slice(-3)).toEqual(["write /home/dl/.domovoi/service.json", "register task", "start task"])
    expect(vi.mocked(effects.write).mock.calls.at(-1)![1]).toBe(serializeServiceConfiguration(configuration))
    const old = installedWslTask(configuration.wsl!, configuration.registrationId!, "/home/dl/.domovoi/service.json")
    const lastRegistration = vi.mocked(effects.capture).mock.calls.filter(([, args]) => script(args).includes("RegisterTaskDefinition")).at(-1)![1]
    expect(lastRegistration).toEqual(old.register.args)
  })

  it("changes nothing when the guest shutdown cannot be proved", async () => {
    const effects = fake("linux", "/home/dl", {}, wslConfiguration())
    delete effects.stopSupervisor
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow("WSL guest shutdown proof is unavailable")
    expect(effects.order).toEqual([])
  })
})

it("is exported as an error the desktop can tell apart", () => {
  expect(new DaemonServiceUpdateError("not-installed")).toBeInstanceOf(Error)
})

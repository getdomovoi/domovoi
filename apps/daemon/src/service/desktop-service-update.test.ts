import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LocalOwnerRecord } from "../local-owner-record.js"
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
import { wslUpdateIntentPath } from "./wsl-install.js"

// Ruled 2026-09-23: "Update the service" swaps the running service to the
// runtime the app now ships, in place, on each platform. Nothing here runs a
// real launchctl, systemctl, schtasks, PowerShell or wsl.exe, and nothing
// reads or writes a real profile: every service manager and the daemon's
// owner record are fakes that record what they were asked, in order.

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
const registrationId = "5b7b2f0e-1111-4222-8333-444455556666"

type Fake = DaemonServiceDependencies & ServiceEffects & {
  order: string[]
  // Starts that leave no daemon reporting ready, as a runtime that fails at
  // start does. Counted from the first start.
  crashingStarts: number
  // What the fake owner record says, and the instances it has named.
  owner: { instanceId: string, state: "ready" | "stopping" | "none" } | undefined
  instances: string[]
  serviceLease: { release: ReturnType<typeof vi.fn<() => void>> }
  profileLeases: { release: ReturnType<typeof vi.fn<() => void>> }[]
  files: Map<string, string>
}

function saved(platform: string, home: string): ServiceConfiguration {
  return { ...createServiceConfiguration({}, { platform, homeDirectory: home, workingDirectory: home }), registrationId }
}

// The PowerShell a Task Scheduler step runs, decoded, so a fake can answer it.
function script(args: readonly string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1]
  return encoded === undefined ? "" : Buffer.from(encoded, "base64").toString("utf16le")
}

function record(owner: NonNullable<Fake["owner"]>): LocalOwnerRecord {
  const identity = { version: 1, instanceId: owner.instanceId, machineId: `machine-${"a".repeat(32)}`, protocolVersion: "0.8.0", owner: "daemon", serviceRegistrationId: registrationId, credential: { source: "environment" } }
  return (owner.state === "ready" ? { ...identity, state: "ready", url: "http://127.0.0.1:8787" } : { ...identity, state: owner.state }) as unknown as LocalOwnerRecord
}

// null: no saved service configuration, as when no service is installed.
function fake(platform: string, home: string, overrides: Partial<Fake> = {}, configuration: ServiceConfiguration | null = saved(platform, home)): Fake {
  const order: string[] = []
  const files = new Map<string, string>([
    [agent, `<plist>${oldRuntime.nodePath}</plist>`],
    [unit, `[Service]\nExecStart=${oldRuntime.nodePath}\n`],
  ])
  let agentLoaded = true
  let starts = 0
  const effects: Fake = {
    order,
    files,
    crashingStarts: 0,
    owner: { instanceId: "instance-old", state: "ready" },
    instances: ["instance-old"],
    serviceLease: { release: vi.fn<() => void>() },
    profileLeases: [],
    platform,
    home,
    uid: 501,
    user: "dl",
    profileReleaseWaitMs: 0,
    readinessWaitMs: 20,
    runtimeFile: vi.fn(async () => "file" as const),
    readConfiguration: vi.fn(() => configuration ?? undefined),
    claimServiceOperation: vi.fn(() => effects.serviceLease),
    claimProfile: vi.fn(() => {
      order.push("claim")
      const lease = { release: vi.fn<() => void>(() => { order.push("release") }) }
      effects.profileLeases.push(lease)
      return lease
    }),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    readOwner: vi.fn(() => effects.owner === undefined ? undefined : record(effects.owner)),
    read: vi.fn(async (path: string) => {
      const contents = files.get(path)
      if (contents === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      return contents
    }),
    write: vi.fn(async (path: string, contents: string) => { order.push(`write ${path}`); files.set(path, contents) }),
    run: vi.fn(async (command: string, args: string[]) => {
      order.push(`${command} ${args.join(" ")}`)
      if (args[0] === "bootout") agentLoaded = false
      if (args[0] === "bootstrap") agentLoaded = true
      if (args[0] === "bootstrap" || args[1] === "restart" || args[0] === "/run") start()
    }),
    capture: vi.fn(async (command: string, args: string[]): Promise<CapturedRun> => {
      const body = script(args)
      if (command === "launchctl" && args[0] === "print") {
        order.push("launchctl print")
        return agentLoaded ? { code: 0, stdout: "\tstate = running\n" } : { code: 113, stdout: "", stderr: "Could not find service \"sh.domovoi.domovoid\" in domain for user gui: 501" }
      }
      if (body.includes("domovoi-task-action")) {
        order.push("read task action")
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ path: "C:\\Program Files\\Domovoi\\runtime-1\\node.exe", arguments: "\"C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js\" --service-config \"C:\\Users\\dl\\.domovoi\\service.json\"" })}\n` }
      }
      if (body.includes("DeleteTask")) { order.push("delete task"); return { code: 0, stdout: "domovoi-task:deleted\n" } }
      if (body.includes("$task.Stop(0)")) { order.push("stop task"); return { code: 0, stdout: "domovoi-task:1\n" } }
      if (body.includes("$task.Enabled = $false")) { order.push("disable task"); return { code: 0, stdout: "domovoi-task:1\n" } }
      if (body.includes("RegisterTaskDefinition")) { order.push("register task"); return { code: 0, stdout: "domovoi-task:created\n" } }
      if (body.includes("$task.Run($null)")) { order.push("start task"); start(); return { code: 0, stdout: "domovoi-task:4\n" } }
      order.push(`capture ${command}`)
      return { code: 0, stdout: "domovoi-task:1\n" }
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    remove: vi.fn(async (path: string) => { order.push(`remove ${path}`); files.delete(path) }),
    stopSupervisor: vi.fn(async () => { order.push("stop guest supervisor") }),
    ...overrides,
  }
  // A start that works leaves a new daemon instance reporting ready.
  function start() {
    starts += 1
    if (starts <= effects.crashingStarts) { effects.owner = undefined; return }
    const instanceId = `instance-${effects.instances.length}`
    effects.instances.push(instanceId)
    effects.owner = { instanceId, state: "ready" }
  }
  return effects
}

beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
afterEach(() => { vi.unstubAllEnvs() })

const nothingChanged = /^Domovoi could not update the service: .+\. Nothing was changed, and the service was left as it was\.$/
const restored = /^Domovoi could not start the service on the new runtime: .+\. The previous service was put back and is running\.$/

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

  // Ruled 2026-09-23: a read that fails before any change is "nothing changed".
  it("says nothing was changed when a read fails before any change", async () => {
    const unreadable = fake("darwin", "/Users/dl", { read: vi.fn(async () => { throw new Error("EACCES: permission denied") }) })
    await expect(updateDaemonService({ runtime }, unreadable)).rejects.toThrow(
      "Domovoi could not update the service: EACCES: permission denied. Nothing was changed, and the service was left as it was.",
    )
    await expect(updateDaemonService({ runtime }, unreadable)).rejects.toMatchObject({ outcome: "nothing-changed" })
    expect(unreadable.order).toEqual([])

    const damaged = fake("darwin", "/Users/dl", { readConfiguration: vi.fn(() => { throw new Error("service.json is not valid") }) })
    await expect(updateDaemonService({ runtime }, damaged)).rejects.toMatchObject({ outcome: "nothing-changed" })
    expect(damaged.order).toEqual([])
  })
})

describe("updateDaemonService with launchd", () => {
  it("boots the agent out, holds the profile while it writes the new agent, then boots it in and waits for ready", async () => {
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
    expect(effects.serviceLease.release).toHaveBeenCalledOnce()
  })

  it("puts the previous agent back and running when the new one will not boot", async () => {
    const effects = fake("darwin", "/Users/dl")
    let bootstraps = 0
    const run = effects.run
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[0] === "bootstrap" && ++bootstraps === 1) { effects.order.push("bootstrap refused"); throw new Error("Bootstrap failed: 5: Input/output error") }
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: Bootstrap failed: 5: Input/output error. The previous service was put back and is running.",
    )
    expect(effects.order.slice(-2)).toEqual([`write ${agent}`, `launchctl bootstrap gui/501 ${agent}`])
    expect(effects.files.get(agent)).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
  })

  // Review of 77c28291 (P1): a bootstrap that succeeds is not a daemon that
  // runs. A runtime that fails at start is a failed swap.
  it("puts the previous agent back when the new daemon never reports ready", async () => {
    const effects = fake("darwin", "/Users/dl", { crashingStarts: 1 })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: the service did not report ready within 1 seconds. The previous service was put back and is running.",
    )
    expect(effects.files.get(agent)).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
    expect(effects.owner).toEqual({ instanceId: "instance-1", state: "ready" })
  })

  it("does not say the previous service is running when it does not report ready either", async () => {
    const effects = fake("darwin", "/Users/dl", { crashingStarts: 2 })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: the service did not report ready within 1 seconds. Putting the previous service back also failed: the service did not report ready within 1 seconds. The service is not running. Check it with `domovoid service status`, then install it again.",
    )
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
    const effects = fake("darwin", "/Users/dl")
    // Another daemon, not the one the update stopped, holds the profile, then
    // lets it go before the previous agent starts again.
    effects.claimProfile = vi.fn(() => {
      effects.owner = { instanceId: "instance-desktop", state: "ready" }
      throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Another Domovoi daemon took this profile while the service was stopped for the update. The previous service was put back and is running.",
    )
    expect(effects.write).not.toHaveBeenCalled()
    expect(vi.mocked(effects.run).mock.calls.map(([, args]) => args[0])).toEqual(["bootout", "bootstrap"])
  })

  // Review of 77c28291 (P2): the daemon the update stopped still holding the
  // profile is a stop that has not finished, not another daemon.
  it("does not blame another daemon when the stopped daemon still holds the profile", async () => {
    const stuck = () => fake("darwin", "/Users/dl", {
      claimProfile: vi.fn(() => { throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi") }),
      readOwner: vi.fn(() => record({ instanceId: "instance-old", state: "stopping" })),
    })
    const refused = updateDaemonService({ runtime }, stuck())
    await expect(refused).rejects.not.toMatchObject({ outcome: "profile-taken-restored" })
    await expect(updateDaemonService({ runtime }, stuck())).rejects.toThrow(
      /^Domovoi could not start the service on the new runtime: the previous service did not let the profile go within 0 seconds\./,
    )
  })

  // Review of 77c28291 (P2): a bootout that reports an error may still have
  // stopped the agent. Still loaded, nothing changed; unloaded, restore it.
  it("says nothing changed when the bootout fails and the agent is still loaded", async () => {
    const effects = fake("darwin", "/Users/dl")
    effects.run = vi.fn(async (command: string, args: string[]) => {
      effects.order.push(`${command} ${args.join(" ")}`)
      if (args[0] === "bootout") throw new Error("Boot-out failed: 36: Operation now in progress")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not update the service: Boot-out failed: 36: Operation now in progress. Nothing was changed, and the service was left as it was.",
    )
    expect(effects.order).toEqual(["launchctl bootout gui/501/sh.domovoi.domovoid", "launchctl print"])
  })

  it("boots the previous agent in when the bootout fails but unloaded it", async () => {
    const effects = fake("darwin", "/Users/dl")
    const run = effects.run
    let bootouts = 0
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      await run(command, args, deadline)
      if (args[0] === "bootout" && ++bootouts === 1) throw new Error("Boot-out failed: 36: Operation now in progress")
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(effects.order.slice(-1)).toEqual([`launchctl bootstrap gui/501 ${agent}`])
    expect(effects.files.get(agent)).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
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
    const run = effects.run
    let restarts = 0
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[1] === "restart" && ++restarts === 1) { effects.order.push("restart refused"); throw new Error("Job for domovoid.service failed") }
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: Job for domovoid.service failed. The previous service was put back and is running.",
    )
    expect(effects.order.slice(-3)).toEqual([`write ${unit}`, "systemctl --user daemon-reload", "systemctl --user restart domovoid.service"])
    expect(effects.files.get(unit)).toBe(`[Service]\nExecStart=${oldRuntime.nodePath}\n`)
  })

  it("puts the previous unit back when a restarted Type=simple unit never reports ready", async () => {
    const effects = fake("linux", "/home/dl", { crashingStarts: 1 })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(effects.files.get(unit)).toBe(`[Service]\nExecStart=${oldRuntime.nodePath}\n`)
  })

  it("says nothing changed when the new unit cannot be written", async () => {
    const effects = fake("linux", "/home/dl", { write: vi.fn(async () => { throw new Error("ENOSPC: no space left on device") }) })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not update the service: ENOSPC: no space left on device. Nothing was changed, and the service was left as it was.",
    )
    expect(effects.run).not.toHaveBeenCalled()
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
    const run = effects.run
    let runs = 0
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[0] === "/run" && ++runs === 1) throw new Error("ERROR: Access is denied.")
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: ERROR: Access is denied. The previous service was put back and is running.",
    )
    const restoredTask = vi.mocked(effects.run).mock.calls.filter(([, args]) => args[0] === "/create").at(-1)![1]
    expect(restoredTask[restoredTask.indexOf("/tr") + 1]).toBe("\"C:\\Program Files\\Domovoi\\runtime-1\\node.exe\" \"C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js\" --service-config \"C:\\Users\\dl\\.domovoi\\service.json\"")
    expect(effects.order.slice(-2)).toEqual([expect.stringMatching(/^schtasks \/create /), "schtasks /run /tn Domovoi daemon"])
  })

  // Review of 77c28291 (P1): a task held running through the stop wait ran
  // the swap out of time. The restore still runs, under its own budget, and
  // both leases are released.
  it("puts the previous task back after a swap that ran out of time", async () => {
    const effects = fake("win32", "C:\\Users\\dl", { updateBudgetMs: 300 })
    const capture = effects.capture
    let stops = 0
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      const body = script(args)
      // The first stop leaves the task running (state 4) for as long as it is asked.
      if (body.includes("$task.Stop(0)")) {
        stops += 1
        effects.order.push("stop task")
        return { code: 0, stdout: stops === 1 ? "domovoi-task:4\n" : "domovoi-task:1\n" }
      }
      if (stops === 1 && body.includes("[int]$task.State") && !body.includes("domovoi-task-action")) return { code: 0, stdout: "domovoi-task:4\n" }
      return capture(command, args, deadline)
    })
    const refused = updateDaemonService({ runtime: windowsRuntime }, effects)
    await expect(refused).rejects.toBeInstanceOf(DaemonServiceUpdateError)
    await expect(refused).rejects.toMatchObject({ outcome: "swap-failed-restored" })
    const created = vi.mocked(effects.run).mock.calls.filter(([, args]) => args[0] === "/create").map(([, args]) => args[args.indexOf("/tr") + 1])
    expect(created).toEqual([expect.stringContaining("runtime-1")])
    expect(effects.order.at(-1)).toBe("schtasks /run /tn Domovoi daemon")
    expect(effects.serviceLease.release).toHaveBeenCalledOnce()
    for (const lease of effects.profileLeases) expect(lease.release).toHaveBeenCalled()
  })

  it("says there is nothing to update when the task is not registered", async () => {
    const effects = fake("win32", "C:\\Users\\dl")
    effects.capture = vi.fn(async () => ({ code: 0, stdout: "domovoi-task:missing\n" }))
    await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toMatchObject({ outcome: "not-installed" })
    expect(effects.run).not.toHaveBeenCalled()
  })
})

describe("updateDaemonService with a WSL guest service (ruled B)", () => {
  const configurationPath = "/home/dl/.domovoi/service.json"
  const intentPath = wslUpdateIntentPath(configurationPath)

  function wslConfiguration(executable = oldRuntime.nodePath, entry = oldRuntime.daemonEntryPath): ServiceConfiguration {
    return {
      ...saved("linux", "/home/dl"),
      wsl: {
        distribution: "Ubuntu", linuxUser: "dl", powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        wsl: "C:\\Windows\\System32\\wsl.exe", executable, args: [entry],
      },
    }
  }

  it("records its intent, retires the old guest task, holds the profile while saving the new runtime, then starts the new task and waits for ready", async () => {
    const configuration = wslConfiguration()
    const effects = fake("linux", "/home/dl", {}, configuration)
    const next = installedWslTask({ ...configuration.wsl!, executable: runtime.nodePath, args: [runtime.daemonEntryPath] }, registrationId, configurationPath)
    expect(await updateDaemonService({ runtime }, effects)).toEqual({ kind: "task", name: next.name, configurationPath })
    expect(effects.order).toEqual([
      `write ${intentPath}`,
      "disable task", "stop guest supervisor", "stop task", "delete task",
      "claim", `write ${configurationPath}`, "release",
      "register task", "start task",
      `remove ${intentPath}`,
    ])
    const written = JSON.parse(effects.files.get(configurationPath)!) as ServiceConfiguration
    expect(written.wsl).toMatchObject({ executable: runtime.nodePath, args: [runtime.daemonEntryPath] })
    expect(written.registrationId).toBe(registrationId)
    const registered = vi.mocked(effects.capture).mock.calls.find(([, args]) => script(args).includes("RegisterTaskDefinition"))![1]
    expect(registered).toEqual(next.register.args)
    expect(effects.files.has(intentPath)).toBe(false)
  })

  it("registers the old task again with the old runtime saved when the new one will not register", async () => {
    const configuration = wslConfiguration()
    const effects = fake("linux", "/home/dl", {}, configuration)
    const capture = effects.capture
    let registrations = 0
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      if (script(args).includes("RegisterTaskDefinition") && ++registrations === 1) {
        effects.order.push("register task refused")
        return { code: 1, stdout: "", stderr: "Access is denied" }
      }
      return capture(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(effects.order.slice(-4)).toEqual([`write ${configurationPath}`, "register task", "start task", `remove ${intentPath}`])
    expect(effects.files.get(configurationPath)).toBe(serializeServiceConfiguration(configuration))
    const old = installedWslTask(configuration.wsl!, registrationId, configurationPath)
    const lastRegistration = vi.mocked(effects.capture).mock.calls.filter(([, args]) => script(args).includes("RegisterTaskDefinition")).at(-1)![1]
    expect(lastRegistration).toEqual(old.register.args)
  })

  it("puts the old task back when the new guest daemon never reports ready", async () => {
    const effects = fake("linux", "/home/dl", { crashingStarts: 1 }, wslConfiguration())
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(effects.owner).toMatchObject({ state: "ready" })
  })

  // Review of 77c28291 (P2): an update that stopped between deleting the old
  // task and registering the new one left no task, perhaps with service.json
  // already naming the new runtime. The intent record says where it started.
  it("starts from the configuration an interrupted update recorded, whatever service.json says", async () => {
    const previous = wslConfiguration()
    const interruptedNext = wslConfiguration("/opt/runtime-half/node", "/opt/runtime-half/index.js")
    const effects = fake("linux", "/home/dl", {}, interruptedNext)
    effects.files.set(intentPath, JSON.stringify({ version: 1, previous: serializeServiceConfiguration(previous), next: serializeServiceConfiguration(interruptedNext) }))
    const next = installedWslTask({ ...previous.wsl!, executable: runtime.nodePath, args: [runtime.daemonEntryPath] }, registrationId, configurationPath)
    expect(await updateDaemonService({ runtime }, effects)).toEqual({ kind: "task", name: next.name, configurationPath })
    expect(effects.order).not.toContain("disable task")
    expect(effects.files.has(intentPath)).toBe(false)
    const written = JSON.parse(effects.files.get(configurationPath)!) as ServiceConfiguration
    expect(written.wsl).toMatchObject({ executable: runtime.nodePath, args: [runtime.daemonEntryPath] })
  })

  it("says nothing changed when the guest shutdown cannot be proved", async () => {
    const effects = fake("linux", "/home/dl", {}, wslConfiguration())
    delete effects.stopSupervisor
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not update the service: WSL guest shutdown proof is unavailable. Nothing was changed, and the service was left as it was.",
    )
    expect(effects.order).toEqual([])
  })
})

it("names each outcome the desktop can tell apart", () => {
  expect(new DaemonServiceUpdateError("not-installed")).toBeInstanceOf(Error)
  expect(new DaemonServiceUpdateError("nothing-changed", new Error("x")).message).toMatch(nothingChanged)
})

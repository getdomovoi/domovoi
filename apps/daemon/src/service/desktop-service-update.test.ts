import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LocalOwnerRecord } from "../local-owner-record.js"
import { OperationDeadline } from "../operation-deadline.js"
import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import {
  DaemonServiceRuntimeMissingError,
  DaemonServiceUpdateError,
  updateDaemonService,
  type DaemonServiceDependencies,
} from "../public.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { nodeServiceEffects, type CapturedRun, type ServiceEffects } from "./install.js"
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
  // The Windows logon task: its registered command, whether an instance of it
  // runs, and the command that instance was started from. Task Scheduler
  // ignores a run while an instance runs, and a stop ends the instance.
  task: { definition: string, running: boolean, runningDefinition: string }
  // A start whose daemon reports ready only this long after it; a stop before
  // then means it never does.
  lateReadyMs: number
}

const oldWindowsCommand = "\"C:\\Program Files\\Domovoi\\runtime-1\\node.exe\" \"C:\\Program Files\\Domovoi\\runtime-1\\daemon\\index.js\" --service-config \"C:\\Users\\dl\\.domovoi\\service.json\""

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
  let pendingReady: ReturnType<typeof setTimeout> | undefined
  const effects: Fake = {
    order,
    files,
    task: { definition: oldWindowsCommand, running: true, runningDefinition: oldWindowsCommand },
    lateReadyMs: 0,
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
      if (args[0] === "/create") effects.task.definition = args[args.indexOf("/tr") + 1]!
      if (args[0] === "/run") {
        if (effects.task.running) return
        effects.task.running = true
        effects.task.runningDefinition = effects.task.definition
      }
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
        const [path, ...rest] = effects.task.definition.split("\" ")
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ path: path!.replace(/^"/u, ""), arguments: rest.join("\" "), enabled: true, state: effects.task.running ? 4 : 3 })}\n` }
      }
      if (body.includes("DeleteTask")) { order.push("delete task"); return { code: 0, stdout: "domovoi-task:deleted\n" } }
      if (body.includes("$task.Stop(0)")) {
        order.push("stop task")
        effects.task.running = false
        if (pendingReady !== undefined) clearTimeout(pendingReady)
        pendingReady = undefined
        return { code: 0, stdout: "domovoi-task:1\n" }
      }
      if (body.includes("$task.Enabled = $false")) { order.push("disable task"); return { code: 0, stdout: "domovoi-task:1\n" } }
      if (body.includes("RegisterTaskDefinition")) { order.push("register task"); return { code: 0, stdout: "domovoi-task:created\n" } }
      if (body.includes("$task.Run($null)")) { order.push("start task"); start(); return { code: 0, stdout: "domovoi-task:4\n" } }
      order.push(`capture ${command}`)
      return { code: 0, stdout: effects.task.running ? "domovoi-task:4\n" : "domovoi-task:1\n" }
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
    const ready = () => {
      const instanceId = `instance-${effects.instances.length}`
      effects.instances.push(instanceId)
      effects.owner = { instanceId, state: "ready" }
    }
    if (effects.lateReadyMs > 0 && starts === 1) pendingReady = setTimeout(ready, effects.lateReadyMs)
    else ready()
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
      "Domovoi could not start the service on the new runtime: the service did not report ready within 1 second. The previous service was put back and is running.",
    )
    expect(effects.files.get(agent)).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
    expect(effects.owner).toEqual({ instanceId: "instance-1", state: "ready" })
  })

  it("does not say the previous service is running when it does not report ready either", async () => {
    const effects = fake("darwin", "/Users/dl", { crashingStarts: 2 })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: the service did not report ready within 1 second. Putting the previous service back also failed: the service did not report ready within 1 second. The service is not running. Check it with `domovoid service status`, then install it again.",
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

  // Ruled 2026-09-23: a profile another daemon holds is named in a few words
  // when putting the previous service back fails too.
  it("names another daemon holding the profile briefly when the restore fails too", async () => {
    const effects = fake("darwin", "/Users/dl")
    effects.claimProfile = vi.fn(() => {
      effects.owner = { instanceId: "instance-desktop", state: "ready" }
      throw new ProfileAlreadyOwnedError("/Users/dl/.domovoi")
    })
    const run = effects.run
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[0] === "bootstrap") throw new Error("old agent refused")
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: another Domovoi daemon holds the profile. Putting the previous service back also failed: old agent refused. The service is not running. Check it with `domovoid service status`, then install it again.",
    )
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
      // The first stop leaves the task running (state 4) for as long as it is
      // asked; a later stop works.
      if (body.includes("$task.Stop(0)") && ++stops === 1) {
        effects.order.push("stop task")
        return { code: 0, stdout: "domovoi-task:4\n" }
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
    // Review round 3 (P3): the record is written just before the delete, once
    // the old task is disabled and its guest supervisor stopped, so status
    // does not report an interrupted update while the old task still runs.
    expect(effects.order).toEqual([
      "disable task", "stop guest supervisor",
      `write ${intentPath}`,
      "stop task", "delete task",
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

  // Ruled 2026-09-23: inside an update, a failed removal of the old task is
  // named in a few words, not with the removal command's own advice.
  it("names a failed removal of the old task briefly, and puts the old task back", async () => {
    const effects = fake("linux", "/home/dl", {}, wslConfiguration())
    const capture = effects.capture
    let deletions = 0
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      if (script(args).includes("DeleteTask") && ++deletions === 1) return { code: 1, stdout: "", stderr: "Access is denied" }
      return capture(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: the old Windows task could not be removed: Access is denied. The previous service was put back and is running.",
    )
  })

  // Ruled 2026-09-23: a damaged intent record has one fixed cause.
  it("says nothing changed, in fixed words, when the record of an interrupted update is damaged", async () => {
    for (const damaged of ["{not json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, previous: "x", next: "y" })]) {
      const effects = fake("linux", "/home/dl", {}, wslConfiguration())
      effects.files.set(intentPath, damaged)
      await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
        "Domovoi could not update the service: the record of an interrupted update is unreadable. Nothing was changed, and the service was left as it was.",
      )
      expect(effects.order).toEqual([])
    }
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

// Review of ae039f1e: each probe the reviewer ran against the fakes.
describe("review round 2 probes", () => {
  const windowsRuntime = { nodePath: "C:\\Program Files\\Domovoi\\runtime-2\\node.exe", daemonEntryPath: "C:\\Program Files\\Domovoi\\runtime-2\\daemon\\index.js" }

  // W2: the new runtime reports ready only after the swap gave up on it. The
  // restore must stop it, or the late record passes for the old service.
  it("W2: stops the task the swap started before putting the old one back", async () => {
    const effects = fake("win32", "C:\\Users\\dl", { lateReadyMs: 60 })
    await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toThrow(restored)
    expect(effects.task.runningDefinition).toBe(oldWindowsCommand)
    expect(effects.order.slice(-3)).toEqual(["stop task", expect.stringMatching(/^schtasks \/create /), "schtasks /run /tn Domovoi daemon"])
  })

  // W1 (round 2, then round 3): the stop is refused while the old task runs.
  // The task still runs the old command, so nothing changed: no restore, and
  // no text saying the service is not running.
  it("W1: says nothing changed when the stop is refused and the old task still runs", async () => {
    for (const refusals of [1, Number.POSITIVE_INFINITY]) {
      const effects = fake("win32", "C:\\Users\\dl")
      const capture = effects.capture
      let stops = 0
      effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
        if (script(args).includes("$task.Stop(0)") && ++stops <= refusals) { effects.order.push("stop refused"); return { code: 1, stdout: "", stderr: "Access is denied." } }
        return capture(command, args, deadline)
      })
      await expect(updateDaemonService({ runtime: windowsRuntime }, effects)).rejects.toThrow(
        "Domovoi could not update the service: Access is denied. Nothing was changed, and the service was left as it was.",
      )
      expect(effects.run).not.toHaveBeenCalled()
      expect(effects.task.runningDefinition).toBe(oldWindowsCommand)
      expect(effects.owner).toEqual({ instanceId: "instance-old", state: "ready" })
    }
  })

  // R1: the owner read right before the restart fails. The old instance's
  // record must not count as the new service's.
  it("R1: never counts the instance that ran before the update as the new one", async () => {
    const effects = fake("linux", "/home/dl")
    const read = effects.readOwner!
    let failed = false
    // The read right before the restart (after the reload) fails, once.
    effects.readOwner = vi.fn((profile) => {
      if (!failed && effects.order.includes("systemctl --user daemon-reload")) {
        failed = true
        throw new Error("local-owner.json is being replaced")
      }
      return read(profile)
    })
    const run = effects.run
    // The restart leaves the old daemon running: nothing new ever reports ready.
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[1] === "restart") { effects.order.push("restart ignored"); return }
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toBeInstanceOf(DaemonServiceUpdateError)
  })

  // S1: once the new service reports ready, a record that cannot be removed
  // does not undo a working update. The next update or status clears it.
  it("S1: keeps a working update when its intent record cannot be removed, and clears the leftover later", async () => {
    const configurationPath = "/home/dl/.domovoi/service.json"
    const intentPath = wslUpdateIntentPath(configurationPath)
    const configuration: ServiceConfiguration = {
      ...saved("linux", "/home/dl"),
      wsl: {
        distribution: "Ubuntu", linuxUser: "dl", powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        wsl: "C:\\Windows\\System32\\wsl.exe", executable: oldRuntime.nodePath, args: [oldRuntime.daemonEntryPath],
      },
    }
    const effects = fake("linux", "/home/dl", {}, configuration)
    const remove = effects.remove
    effects.remove = vi.fn(async (path: string, deadline) => {
      if (path === intentPath) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
      await remove(path, deadline)
    })
    expect(await updateDaemonService({ runtime }, effects)).toMatchObject({ kind: "task" })
    expect(effects.files.has(intentPath)).toBe(true)
    // Security review round 1 (F6): the leftover is marked as finished, with
    // the new service running, once that service has reported ready.
    expect(effects.order.slice(-2)).toEqual(["start task", `write ${intentPath}`])
    expect(JSON.parse(effects.files.get(intentPath)!)).toMatchObject({ completed: "next" })

    // The next update: the leftover is marked finished with the configuration
    // now saved, so it is cleared rather than rolled back.
    // As the service reads it.
    const now = parseServiceConfiguration(effects.files.get(configurationPath)!)
    const next = fake("linux", "/home/dl", {}, now)
    next.files.set(intentPath, effects.files.get(intentPath)!)
    const newer = { nodePath: "/opt/runtime-3/node", daemonEntryPath: "/opt/runtime-3/index.js" }
    expect(await updateDaemonService({ runtime: newer }, next)).toMatchObject({ kind: "task" })
    expect(next.order).toContain("disable task")
    expect(next.files.has(intentPath)).toBe(false)
  })

  // L1: launchctl can list the job right after error 36 and unload it a
  // moment later. The update watches for a while before deciding.
  it("L1: watches a bootout that errored, and restores once the agent unloads", async () => {
    const effects = fake("darwin", "/Users/dl", { profileReleaseWaitMs: 100 })
    const run = effects.run
    const capture = effects.capture
    let bootouts = 0
    let prints = 0
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[0] === "bootout" && ++bootouts === 1) { effects.order.push("bootout error 36"); throw new Error("Boot-out failed: 36: Operation now in progress") }
      await run(command, args, deadline)
    })
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      if (command === "launchctl" && args[0] === "print" && ++prints <= 2) {
        effects.order.push("launchctl print")
        // Loaded at first, unloaded from the second look on.
        return prints === 1 ? { code: 0, stdout: "\tstate = running\n" } : { code: 113, stdout: "", stderr: "Could not find service \"sh.domovoi.domovoid\" in domain for user gui: 501" }
      }
      return capture(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(effects.order.at(-1)).toBe(`launchctl bootstrap gui/501 ${agent}`)
  })

  // A step that ran out of time may still be running. The restore waits for
  // it to settle before it starts, and the lease is held until then.
  it("waits for a timed-out call to settle before restoring", async () => {
    const effects = fake("darwin", "/Users/dl", { updateBudgetMs: 50 })
    const run = effects.run
    let bootstraps = 0
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[0] === "bootstrap" && ++bootstraps === 1) {
        effects.order.push("bootstrap started")
        // A manager call that outlives its deadline and ignores the abort.
        await new Promise((resolve) => setTimeout(resolve, 150))
        effects.order.push("bootstrap settled")
        await run(command, args, deadline)
        return
      }
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toBeInstanceOf(DaemonServiceUpdateError)
    const settled = effects.order.indexOf("bootstrap settled")
    expect(settled).toBeGreaterThan(-1)
    const restoreStart = effects.order.findIndex((entry, index) => index > effects.order.indexOf("bootstrap started") && entry !== "bootstrap settled" && !entry.startsWith("launchctl bootstrap gui/501"))
    expect(restoreStart).toBeGreaterThan(settled)
    expect(effects.serviceLease.release).toHaveBeenCalledOnce()
  })

  it("P3: says one second, not one seconds", async () => {
    const effects = fake("darwin", "/Users/dl", { crashingStarts: 1, readinessWaitMs: 1_000 })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow("did not report ready within 1 second.")
  })
})

// Security review of 79ba81e4: each finding as the fakes reproduce it.
describe("security review round 1", () => {
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

  // F1: a WSL removal held the service-operation lease and finished while
  // the update waited for it. The update must read service.json under the
  // lease, or it recreates and starts the service that was just removed.
  it("F1: reads the saved configuration only once it holds the service-operation lease", async () => {
    let configuration: ServiceConfiguration | undefined = wslConfiguration()
    const effects = fake("linux", "/home/dl", {}, configuration)
    effects.readConfiguration = vi.fn(() => configuration)
    effects.claimServiceOperation = vi.fn(() => {
      // The removal finishes, service.json goes, and the lease is free.
      configuration = undefined
      effects.order.push("service lease")
      return effects.serviceLease
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toMatchObject({ outcome: "not-installed" })
    expect(effects.order).toEqual(["service lease"])
    expect(effects.write).not.toHaveBeenCalled()
    expect(effects.capture).not.toHaveBeenCalled()
    expect(effects.serviceLease.release).toHaveBeenCalledOnce()
  })

  // F2: a unit write that ran out of time can still publish the new unit
  // afterwards. That is not "nothing changed": the swap failed, and the
  // previous unit is put back once the write has settled.
  it("F2: puts the previous unit back after a unit write that timed out and published late", async () => {
    const effects = fake("linux", "/home/dl", { updateBudgetMs: 50 })
    const write = effects.write
    effects.write = vi.fn(async (path: string, contents: string, deadline) => {
      if (contents.includes(runtime.nodePath)) {
        effects.order.push("new unit write started")
        await new Promise((resolve) => setTimeout(resolve, 150))
        effects.order.push("new unit write settled")
      }
      await write(path, contents, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toMatchObject({ outcome: "swap-failed-restored" })
    expect(effects.files.get(unit)).toBe(`[Service]\nExecStart=${oldRuntime.nodePath}\n`)
    expect(effects.order.indexOf("new unit write settled")).toBeLessThan(effects.order.lastIndexOf(`write ${unit}`))
    expect(effects.order.slice(-2)).toEqual(["systemctl --user daemon-reload", "systemctl --user restart domovoid.service"])
  })

  // F4: the restore started after a fixed wait even with the new agent's
  // write still pending, and the late write replaced the restored agent. The
  // restore waits for the write to settle, however long that takes, and the
  // profile stays held until it has.
  it("F4: restores only once a pending agent write settles, never on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const effects = fake("darwin", "/Users/dl", { updateBudgetMs: 50 })
      const write = effects.write
      let finish: (() => void) | undefined
      effects.write = vi.fn(async (path: string, contents: string, deadline) => {
        if (contents.includes(runtime.nodePath)) {
          effects.order.push("new agent write started")
          await new Promise<void>((resolve) => { finish = resolve })
          effects.order.push("new agent write settled")
        }
        await write(path, contents, deadline)
      })
      const outcome = updateDaemonService({ runtime }, effects).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(50)
      // Far past any fixed wait: nothing may be restored yet.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(effects.order.at(-1)).toBe("new agent write started")
      expect(effects.profileLeases.filter((lease) => lease.release.mock.calls.length === 0)).toHaveLength(1)
      finish!()
      expect(await outcome).toMatchObject({ outcome: "swap-failed-restored" })
      expect(effects.files.get(agent)).toBe(`<plist>${oldRuntime.nodePath}</plist>`)
      expect(effects.order.indexOf("new agent write settled")).toBeLessThan(effects.order.lastIndexOf(`write ${agent}`))
      expect(effects.serviceLease.release).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  // F5: every owner read before the restart failed, so no instance was on
  // record, and the old daemon, left running by a restart that did nothing,
  // passed for the new one once its record could be read again.
  it("F5: refuses the update when the owner record cannot be read before any change", async () => {
    const effects = fake("linux", "/home/dl")
    const read = effects.readOwner!
    let failures = 10
    effects.readOwner = vi.fn((profile) => {
      if (failures > 0) { failures -= 1; throw new Error("EACCES: permission denied, open 'local-owner.json'") }
      return read(profile)
    })
    const run = effects.run
    effects.run = vi.fn(async (command: string, args: string[], deadline) => {
      if (args[1] === "restart") { effects.order.push("restart ignored"); return }
      await run(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not update the service: EACCES: permission denied, open 'local-owner.json'. Nothing was changed, and the service was left as it was.",
    )
    expect(effects.order).toEqual([])
  })

  // F6: service.json equal to the record's next configuration counted as a
  // finished update, though the new task never reported ready (the swap was
  // interrupted after saving it). The next failed update then put back the
  // unready runtime and lost the one that ran before.
  it("F6: keeps the recorded previous runtime as the restore target until the new task has reported ready", async () => {
    const previous = wslConfiguration()
    const unready = wslConfiguration("/opt/runtime-half/node", "/opt/runtime-half/index.js")
    // As the service reads it.
    const effects = fake("linux", "/home/dl", {}, parseServiceConfiguration(serializeServiceConfiguration(unready)))
    effects.files.set(intentPath, JSON.stringify({ version: 1, previous: serializeServiceConfiguration(previous), next: serializeServiceConfiguration(unready) }))
    const capture = effects.capture
    let registrations = 0
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      if (script(args).includes("RegisterTaskDefinition") && ++registrations === 1) return { code: 1, stdout: "", stderr: "Access is denied" }
      return capture(command, args, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(restored)
    expect(parseServiceConfiguration(effects.files.get(configurationPath)!).wsl).toEqual(previous.wsl)
    const lastRegistration = vi.mocked(effects.capture).mock.calls.filter(([, args]) => script(args).includes("RegisterTaskDefinition")).at(-1)![1]
    expect(lastRegistration).toEqual(installedWslTask(previous.wsl!, registrationId, configurationPath).register.args)
  })

  // F7: the old task was put back and reported ready, then removing the
  // intent record failed, and the update said the service was not running.
  it("F7: says the previous service is running when only removing the record fails after the restore", async () => {
    const effects = fake("linux", "/home/dl", {}, wslConfiguration())
    const capture = effects.capture
    let registrations = 0
    effects.capture = vi.fn(async (command: string, args: string[], deadline) => {
      if (script(args).includes("RegisterTaskDefinition") && ++registrations === 1) return { code: 1, stdout: "", stderr: "Access is denied" }
      return capture(command, args, deadline)
    })
    const remove = effects.remove
    effects.remove = vi.fn(async (path: string, deadline) => {
      if (path === intentPath) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
      await remove(path, deadline)
    })
    await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
      "Domovoi could not start the service on the new runtime: Access is denied. The previous service was put back and is running.",
    )
    expect(effects.owner).toMatchObject({ state: "ready" })
    // Left for later cleanup, marked as settled with the previous service.
    expect(JSON.parse(effects.files.get(intentPath)!)).toMatchObject({ completed: "previous" })
  })

  // F3: a planted intent record supplied the previous configuration that a
  // rollback registers and starts. A record must agree with the saved
  // registration on everything but the runtime, and name a runtime of the
  // shape an install or update writes: an absolute executable and at most one
  // absolute daemon entry.
  it("F3: refuses an intent record that does not match the saved registration, changing nothing", async () => {
    const planted = wslConfiguration("/tmp/planted/node", "/tmp/planted/index.js")
    for (const previous of [
      { ...planted, registrationId: "00000000-0000-4000-8000-000000000000" },
      { ...planted, wsl: { ...planted.wsl!, linuxUser: "root" } },
      { ...planted, profileDirectory: "/tmp/planted-profile" },
      wslConfiguration("/tmp/planted/node", "planted/index.js"),
      { ...planted, wsl: { ...planted.wsl!, args: ["/tmp/planted/index.js", "/tmp/planted/more.js"] } },
    ]) {
      const effects = fake("linux", "/home/dl", {}, wslConfiguration())
      effects.files.set(intentPath, JSON.stringify({ version: 1, previous: serializeServiceConfiguration(previous), next: serializeServiceConfiguration(wslConfiguration()) }))
      await expect(updateDaemonService({ runtime }, effects)).rejects.toThrow(
        "Domovoi could not update the service: the record of an interrupted update is unreadable. Nothing was changed, and the service was left as it was.",
      )
      expect(effects.order).toEqual([])
    }
  })

  // F3: the read effect followed a symbolic link and took any file. It now
  // reads a service record only as a bounded private regular file owned by
  // this user, without following a link. No Windows form: O_NOFOLLOW and
  // POSIX modes do not exist there, and the WSL intent record lives in a
  // Linux guest.
  it.skipIf(process.platform === "win32")("F3: reads a service record only as a private regular file, never through a link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-service-read-"))
    const deadline = OperationDeadline.start(5_000)
    try {
      const read = nodeServiceEffects().read!
      const target = join(directory, "planted.json")
      await writeFile(target, "{}", { mode: 0o600 })
      const linked = join(directory, "service.json.update-intent.json")
      await symlink(target, linked)
      await expect(read(linked, deadline)).rejects.toThrow()
      const shared = join(directory, "shared.json")
      await writeFile(shared, "{}")
      await chmod(shared, 0o644)
      await expect(read(shared, deadline)).rejects.toThrow()
      const own = join(directory, "own.json")
      await writeFile(own, "{\"version\":1}", { mode: 0o600 })
      expect(await read(own, deadline)).toBe("{\"version\":1}")
    } finally {
      deadline.clear()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it("names each outcome the desktop can tell apart", () => {
  expect(new DaemonServiceUpdateError("not-installed")).toBeInstanceOf(Error)
  expect(new DaemonServiceUpdateError("nothing-changed", new Error("x")).message).toMatch(nothingChanged)
})

import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { installService, removeService, runServiceCommand, servicePlan, serviceStatus, type ServiceEffects } from "./install.js"
import { windowsTreeUnknown } from "./windows-job-supervisor.js"

beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => vi.unstubAllEnvs())
const home = "C:\\Users\\test"
const target = { platform: "win32", home, user: "test", execPath: "C:\\Domovoi\\index.js", runtime: "C:\\Domovoi\\node.exe",
  configuration: { ...createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
    registrationId: randomUUID(), serviceRuntime: { executable: "C:\\Domovoi\\node.exe", entry: "C:\\Domovoi\\index.js" } } }
function fixture() {
  const events: string[] = []
  const task = { enabled: true, running: true, queued: false, instances: 0, exists: true, flag: "--service-supervise", path: target.runtime, entry: target.execPath }
  const effects: ServiceEffects = {
    readConfiguration: () => target.configuration,
    claimServiceOperation: () => ({ release() {} }), claimProfile: () => ({ release() {} }),
    removalSnapshot: () => ({ owner: undefined, configurationDigest: null }), writeRemovalReceipt: vi.fn(),
    read: vi.fn(async () => ""), write: vi.fn(async () => { events.push("write") }), remove: vi.fn(async () => { events.push("remove-config") }),
    exists: vi.fn(async () => true), run: vi.fn(async () => {}),
    supervisorStatus: vi.fn(async () => ({ installed: null, running: false, detail: "supervision exhausted", supervisionFailure: "exhausted" as const })),
    stopSupervisor: vi.fn(async () => { events.push("prove-empty") }),
    capture: vi.fn(async (_command, args) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (!task.exists) return { code: 0, stdout: "domovoi-task:missing" }
      if (script.includes("domovoi-task-action:")) return { code: 0, stdout: "domovoi-task-action:" + JSON.stringify({
        path: task.path, arguments: `"${task.entry}" ${task.flag} "${home}\\.domovoi\\service.json"`, enabled: task.enabled, state: task.running ? 4 : 1,
      }) }
      if (script.includes("$task.GetInstances(0).Count")) return { code: 0, stdout: `domovoi-task:${!task.enabled && !task.running && !task.queued && task.instances === 0 ? 1 : 0}` }
      if (script.includes("$task.Enabled = $false")) { events.push("disable"); task.enabled = false }
      if (script.includes("$task.Stop(0)")) { events.push("stop-task"); task.running = false }
      if (script.includes("$folder.DeleteTask(")) { events.push("delete-task"); task.exists = false; return { code: 0, stdout: "domovoi-task:deleted" } }
      return { code: 0, stdout: `domovoi-task:${task.running ? 4 : 1}` }
    }),
  }
  return { effects, events, task }
}

it("registers the logon supervisor action", () => {
  const plan = servicePlan(target)
  expect(plan.commands.find((c) => c.args.includes("/tr"))?.args.join(" ")).toContain("--service-supervise")
})

it("returns status exit 1 on exhaustion even with a registered running task", async () => {
  const f = fixture(), stdout = vi.fn()
  expect(await runServiceCommand(["service", "status"], { ...target, ...f.effects, stdout, stderr: vi.fn() })).toBe(1)
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("supervision exhausted"))
})

it("disables starts and proves every job empty before stopping or deleting the task", async () => {
  const f = fixture()
  await removeService(target, f.effects)
  expect(f.events).toEqual(["disable", "prove-empty", "disable", "stop-task", "delete-task", "remove-config"])
})

it("retains task and config on unconfirmed tree, including a disappeared task", async () => {
  for (const exists of [true, false]) {
    const f = fixture(); f.task.exists = exists
    f.effects.stopSupervisor = vi.fn(async () => { throw new Error(windowsTreeUnknown) })
    await expect(removeService(target, f.effects)).rejects.toThrow("Restart Windows")
    expect(f.effects.remove).not.toHaveBeenCalled()
    expect(f.events).not.toContain("stop-task")
    expect(f.events).not.toContain("delete-task")
  }
})

it("refuses replacing a task while its supervisor is backing off or its tree is unconfirmed", async () => {
  const f = fixture()
  f.effects.supervisorStatus = vi.fn(async () => ({ installed: null, running: false, supervising: true, detail: "backoff" }))
  await expect(installService(target, f.effects)).rejects.toThrow("supervisor")
  expect(f.effects.write).not.toHaveBeenCalled()
  f.effects.supervisorStatus = vi.fn(async () => ({ installed: null, running: false, treeUnconfirmed: true, detail: windowsTreeUnknown, supervisionFailure: "observation-failure" as const }))
  await expect(installService(target, f.effects)).rejects.toThrow("Restart Windows")
  expect(f.effects.write).not.toHaveBeenCalled()
})

it.each(["stopped", "exhausted"] as const)("retires an enabled %s supervisor before reinstall writes configuration", async (state) => {
  const f = fixture(); f.task.running = false
  f.effects.supervisorStatus = vi.fn(async () => ({ installed: null, running: false, detail: state,
    ...(state === "exhausted" ? { supervisionFailure: "exhausted" as const } : {}) }))
  let retired = false
  f.effects.stopSupervisor = vi.fn(async (_path, _deadline, options) => {
    expect(f.task.enabled).toBe(false)
    expect(options?.retire).toBe(false)
    expect(await options?.confirmNoLaunch?.()).toBe(true)
    if (!await options?.stopTask?.()) throw new Error("Task remains observable")
    retired = true
  })
  f.effects.write = vi.fn(async () => {
    // A logon/manual start of the old registration cannot win this seam.
    expect(f.task.enabled).toBe(false)
    expect(retired).toBe(true)
  })
  await installService(target, f.effects)
  expect(f.effects.stopSupervisor).toHaveBeenCalledOnce()
  expect(f.effects.write).toHaveBeenCalled()
  expect(f.events).toContain("stop-task")
})

it("retains configuration if an exhausted supervisor cannot be retired for reinstall", async () => {
  const f = fixture()
  f.effects.stopSupervisor = vi.fn(async () => { throw new Error("Retirement unconfirmed") })
  await expect(installService(target, f.effects)).rejects.toThrow("Retirement unconfirmed")
  expect(f.effects.write).not.toHaveBeenCalled()
  expect(f.effects.run).not.toHaveBeenCalled()
})

it.each(["before-reinstall", "during-stop"] as const)("reinstalls with proven terminal evidence when the task disappears %s", async (when) => {
  const f = fixture(); f.task.running = false
  if (when === "before-reinstall") f.task.exists = false
  f.effects.stopSupervisor = vi.fn(async (_path, _deadline, options) => {
    // The real stop path invokes this only after validating evidence under its lease.
    if (when === "during-stop") f.task.exists = false
    if (!await options?.stopTask?.()) throw new Error("Task remains observable")
    f.events.push("prove-empty")
  })
  await installService(target, f.effects)
  expect(f.effects.stopSupervisor).toHaveBeenCalledOnce()
  expect(f.events.indexOf("prove-empty")).toBeLessThan(f.events.indexOf("write"))
  expect(f.effects.write).toHaveBeenCalled()
  expect(vi.mocked(f.effects.run).mock.calls.some(([, args]) => args[0] === "/create")).toBe(true)
})

it("refuses reinstall of a missing task when its tree proof fails", async () => {
  const f = fixture(); f.task.exists = false
  f.effects.stopSupervisor = vi.fn(async () => { throw new Error(windowsTreeUnknown) })
  await expect(installService(target, f.effects)).rejects.toThrow("Restart Windows")
  expect(f.effects.write).not.toHaveBeenCalled()
  expect(f.effects.run).not.toHaveBeenCalled()
})

it("retires a legacy task using the scheduler before removing configuration", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  await removeService(target, f.effects)
  expect(f.events).toEqual(["disable", "stop-task", "delete-task", "remove-config"])
  expect(f.effects.stopSupervisor).not.toHaveBeenCalled()
})

it("migrates a legacy install to a supervised action after retiring it", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  f.effects.supervisorStatus = vi.fn(async () => undefined)
  await installService(target, f.effects)
  expect(f.events.indexOf("stop-task")).toBeLessThan(f.events.indexOf("write"))
  expect(f.events).toContain("delete-task")
  const creation = vi.mocked(f.effects.run).mock.calls.find(([, args]) => args[0] === "/create")
  expect(creation?.[1].join(" ")).toContain("--service-supervise")
  expect(f.effects.stopSupervisor).not.toHaveBeenCalled()
})

it("refuses legacy migration if the re-read action changed to supervision", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  const capture = f.effects.capture
  let actions = 0
  f.effects.capture = vi.fn(async (command, args, deadline) => {
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
    if (script.includes("domovoi-task-action:") && ++actions === 2) f.task.flag = "--service-supervise"
    return capture(command, args, deadline)
  })
  await expect(installService(target, f.effects)).rejects.toThrow("registration changed")
  expect(f.events).toEqual([])
})

it("keeps a stopped legacy registration when writing the replacement fails", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  f.effects.write = vi.fn(async () => { throw new Error("write failed") })
  await expect(installService(target, f.effects)).rejects.toThrow("write failed")
  expect(f.task).toMatchObject({ exists: true, enabled: false, running: false })
  expect(f.effects.run).not.toHaveBeenCalled()
})

it("restores a disabled legacy registration if supervised registration fails", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  f.effects.run = vi.fn(async (_command, args) => {
    if (args[0] === "/create" && args.join(" ").includes("--service-supervise")) throw new Error("create failed")
    if (args[0] === "/create") { f.task.exists = true; f.task.enabled = true }
  })
  await expect(installService(target, f.effects)).rejects.toThrow("create failed")
  expect(f.task).toMatchObject({ exists: true, enabled: false, running: false })
  expect(vi.mocked(f.effects.run).mock.calls.some(([, args]) => args[0] === "/create" && args.join(" ").includes("--service-config"))).toBe(true)
})

it.each(["remove", "install"] as const)("retains a legacy task and config if %s cannot confirm zero instances", async (operation) => {
  const f = fixture(); f.task.flag = "--service-config"; f.task.instances = 1
  await expect(operation === "remove" ? removeService(target, f.effects) : installService(target, f.effects)).rejects.toThrow("zero instances")
  expect(f.events).not.toContain("delete-task")
  expect(f.events).not.toContain("write")
  expect(f.events).not.toContain("remove-config")
})

it("does not lose unconfirmed evidence when both task and configuration disappeared", async () => {
  const f = fixture(); f.task.exists = false
  f.effects.readConfiguration = () => undefined
  f.effects.supervisorStatus = async () => ({ installed: null, running: false, treeUnconfirmed: true, detail: windowsTreeUnknown, supervisionFailure: "configuration-missing" })
  await expect(removeService(target, f.effects)).rejects.toThrow("Restart Windows")
  expect(f.effects.remove).not.toHaveBeenCalled()
})

function withoutLaunchHistory(f: ReturnType<typeof fixture>) {
  f.effects.supervisorStatus = vi.fn(async () => undefined)
  f.effects.stopSupervisor = vi.fn(async (_path, _deadline, options) => {
    if (!await options?.confirmNoLaunch?.()) throw new Error("No lease or record and no disabled supervised task proof")
    f.events.push("prove-no-launch")
    if (options.stopTask && !await options.stopTask()) throw new Error("Task remains observable")
  })
}

it.each(["remove", "install"] as const)("can %s a supervised task that never claimed its lease", async (operation) => {
  const f = fixture(); f.task.running = false
  withoutLaunchHistory(f)
  if (operation === "remove") {
    await removeService(target, f.effects)
    expect(f.events).toContain("remove-config")
  } else {
    await installService(target, f.effects)
    expect(f.events).toContain("write")
  }
  expect(f.events.slice(0, 2)).toEqual(["disable", "prove-no-launch"])
})

it.each(["remove", "install"] as const)("refuses %s without launch history when scheduler evidence is insufficient", async (operation) => {
  for (const state of ["missing", "running", "queued", "instance"] as const) {
    const f = fixture()
    f.task.exists = state !== "missing"; f.task.running = state === "running"
    f.task.queued = state === "queued"; f.task.instances = state === "instance" ? 1 : 0
    withoutLaunchHistory(f)
    await expect(operation === "remove" ? removeService(target, f.effects) : installService(target, f.effects)).rejects.toThrow()
    expect(f.effects.write).not.toHaveBeenCalled()
    expect(f.effects.remove).not.toHaveBeenCalled()
    expect(f.events).not.toContain("stop-task")
    expect(f.events).not.toContain("delete-task")
  }
})

it.each(["status", "install", "remove"] as const)("passes the original %s deadline to supervisor observation", async (operation) => {
  const f = fixture()
  if (operation === "remove") { f.task.exists = false; f.effects.readConfiguration = () => undefined }
  if (operation === "status") await serviceStatus(target, f.effects)
  else if (operation === "install") await installService(target, f.effects)
  else await removeService(target, f.effects)
  const deadline = vi.mocked(f.effects.capture).mock.calls[0]![2]
  expect(deadline).toBeInstanceOf(OperationDeadline)
  expect(f.effects.supervisorStatus).toHaveBeenCalledExactlyOnceWith(home, deadline)
  if (operation === "install" || operation === "remove") {
    for (const call of vi.mocked(f.effects.stopSupervisor!).mock.calls) expect(call[1]).toBe(deadline)
  }
})

it.each([
  [true, "publish"], [false, "publish"], [true, "write"], [false, "write"],
  [true, "register"], [false, "register"], [true, "register-deleted"], [false, "register-deleted"],
] as const)("restores supervised registration enabled=%s after %s failure without starting it", async (enabled, phase) => {
  const f = fixture(); f.task.enabled = enabled; f.task.running = false
  const oldConfiguration = serializeServiceConfiguration(target.configuration)
  let configuration = oldConfiguration
  const replacement = { ...target, runtime: "C:\\Domovoi-next\\node.exe", execPath: "C:\\Domovoi-next\\index.js" }
  f.effects.read = vi.fn(async () => configuration)
  f.effects.write = vi.fn(async (_path, contents) => {
    if (phase === "write" && contents !== oldConfiguration) throw new Error("write failed")
    configuration = contents
  })
  let retired = true
  f.effects.stopSupervisor = vi.fn(async (_path, _deadline, options) => {
    expect(options?.retire).toBe(false)
    if (!await options?.stopTask?.()) throw new Error("Task remains observable")
    retired = false
  })
  let registrationFailed = false
  f.effects.run = vi.fn(async (_command, args) => {
    if (args[0] === "/create") {
      if (phase.startsWith("register") && !registrationFailed) {
        registrationFailed = true
        if (phase === "register-deleted") f.task.exists = false
        throw new Error("register failed")
      }
      const action = /^"([^"]+)" "([^"]+)" --service-supervise /.exec(args[args.indexOf("/tr") + 1]!)
      if (!action) throw new Error("Invalid restored action")
      f.task.path = action[1]!; f.task.entry = action[2]!; f.task.exists = true; f.task.enabled = true
    }
    if (args[0] === "/change") f.task.enabled = args.includes("/enable")
    if (args[0] === "/run") throw new Error("Rollback must not start the task")
  })
  await expect(installService(replacement, f.effects, { beforeChanges: async () => {
    if (phase === "publish") throw new Error("publish failed")
  } })).rejects.toThrow(`${phase.startsWith("register") ? "register" : phase} failed`)
  expect(configuration).toBe(oldConfiguration)
  expect(f.task).toMatchObject({ exists: true, enabled, running: false, path: target.runtime, entry: target.execPath })
  expect(retired).toBe(false)
  expect(vi.mocked(f.effects.run).mock.calls.some(([, args]) => args[0] === "/run")).toBe(false)
})

it("keeps the old task disabled if configuration restoration fails", async () => {
  const f = fixture(); f.task.running = false
  f.effects.stopSupervisor = vi.fn(async (_path, _deadline, options) => {
    if (!await options?.stopTask?.()) throw new Error("Task remains observable")
  })
  f.effects.write = vi.fn(async () => { throw new Error("disk full") })
  await expect(installService(target, f.effects)).rejects.toThrow("Putting back the previous service files also failed")
  expect(f.task.enabled).toBe(false)
  expect(f.effects.run).not.toHaveBeenCalled()
})

it("reports a failed task restoration together with the original reinstall failure", async () => {
  const f = fixture(); f.task.running = false
  f.effects.run = vi.fn(async () => { throw new Error("scheduler denied restoration") })
  await expect(installService(target, f.effects, { beforeChanges: async () => { throw new Error("publication failed") } }))
    .rejects.toThrow("publication failed. Restoring the previous Windows task also failed: scheduler denied restoration")
  expect(f.task.enabled).toBe(false)
})

import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServiceConfiguration } from "./configuration.js"
import { installService, removeService, runServiceCommand, servicePlan, type ServiceEffects } from "./install.js"
import { windowsTreeUnknown } from "./windows-job-supervisor.js"

beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => vi.unstubAllEnvs())
const home = "C:\\Users\\test"
const target = { platform: "win32", home, user: "test", execPath: "C:\\Domovoi\\index.js", runtime: "C:\\Domovoi\\node.exe",
  configuration: { ...createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
    registrationId: randomUUID(), serviceRuntime: { executable: "C:\\Domovoi\\node.exe", entry: "C:\\Domovoi\\index.js" } } }
function fixture() {
  const events: string[] = []
  const task = { enabled: true, running: true, queued: false, instances: 0, exists: true, flag: "--service-supervise" }
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
        path: target.runtime, arguments: `"${target.execPath}" ${task.flag} "${home}\\.domovoi\\service.json"`, enabled: task.enabled, state: task.running ? 4 : 1,
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

it("recognizes but refuses legacy task removal without job evidence", async () => {
  const f = fixture(); f.task.flag = "--service-config"
  await expect(removeService(target, f.effects)).rejects.toThrow("legacy")
  expect(f.events).toEqual([])
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

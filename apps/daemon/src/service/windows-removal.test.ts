import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { ProfileAlreadyOwnedError } from "../profile-lease.js"
import { createServiceConfiguration, type ServiceConfiguration } from "./configuration.js"
import { removeService, runServiceCommand, type ServiceEffects } from "./install.js"
import { ServiceOperationBusyError } from "./operation-lease.js"
import { windowsTaskRemovalPlan } from "./windows-task.js"

beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
afterEach(() => { vi.unstubAllEnvs() })

// Vitest's clock does not replace node:timers/promises. Keep the same abort
// contract while routing its finite poll through the controlled clock.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value) }, ms)
    signal.addEventListener("abort", abort, { once: true })
  }),
}))

// Ruled 2026-09-25: removal first reads the task's action and service.json to
// check that Domovoi registered the task. These fakes answer that read with a
// Domovoi registration; the sequences below start with it.
const configurationPath = "C:\\Users\\dl\\.domovoi\\service.json"
const registeredAction = { path: '"C:\\Domovoi\\node.exe"', arguments: `"C:\\Domovoi\\index.js" --service-config "${configurationPath}"` }
const registered = { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ ...registeredAction, enabled: true, state: 4 })}\r\n` }
const isActionRead = (args: string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("domovoi-task-action:")

// Model the OS boundary, not a mock which assumes unregistering kills a task.
// Microsoft's /delete contract explicitly leaves running programs alone.
function taskManager() {
  const task = { registered: true, enabled: true, running: true }
  const effects: ServiceEffects = {
    readConfiguration: vi.fn((home: string) => createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home })),
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    run: vi.fn(async (command, args) => {
      expect(command).toBe("schtasks")
      expect(args).toEqual(["/delete", "/tn", "Domovoi daemon", "/f"])
      task.registered = false
    }),
    capture: vi.fn(async (command, args) => {
      expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (script.includes("domovoi-task-action:")) {
        if (!task.registered) return { code: 0, stdout: "domovoi-task:missing\r\n" }
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ ...registeredAction, enabled: task.enabled, state: task.running ? 4 : task.enabled ? 3 : 1 })}\r\n` }
      }
      if (script.includes("$task.Enabled = $false")) task.enabled = false
      if (script.includes("$task.Stop(0)")) task.running = false
      if (script.includes("$folder.DeleteTask(")) {
        expect(task, "the registration must survive until every instance stopped").toMatchObject({ enabled: false, running: false })
        task.registered = false
        return { code: 0, stdout: "domovoi-task:deleted\r\n" }
      }
      return { code: 0, stdout: `domovoi-task:${task.registered ? task.running ? 4 : task.enabled ? 3 : 1 : "missing"}\r\n` }
    }),
  }
  return { task, effects }
}

describe("Windows service removal", () => {
  it("stops the live task before unregistering it and deleting its configuration", async () => {
    const { task, effects } = taskManager()
    vi.mocked(effects.remove).mockImplementation(async () => {
      expect(task).toEqual({ registered: false, enabled: false, running: false })
    })

    await removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)

    expect(task).toEqual({ registered: false, enabled: false, running: false })
    expect(effects.remove).toHaveBeenCalledOnce()
  })

  it("does not tell the CLI user a running daemon was removed", async () => {
    const { task, effects } = taskManager()
    const stdout = vi.fn()
    const stderr = vi.fn()
    expect(await runServiceCommand(["service", "remove"], {
      ...effects, platform: "win32", execPath: "C:\\Domovoi\\domovoid.exe", home: "C:\\Users\\dl", stdout, stderr,
    })).toBe(0)
    expect(stderr).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith("Removed the Domovoi daemon service Domovoi daemon\n")
    expect(task.running, "a success message must mean the supervised daemon stopped").toBe(false)
  })

  it("observes a delayed stop before deleting and spends one original deadline", async () => {
    vi.useFakeTimers()
    try {
      const { effects } = taskManager()
      const observed: number[] = []
      vi.mocked(effects.capture).mockResolvedValueOnce(registered).mockImplementationOnce(async (_command, _args, deadline) => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        observed.push(deadline.remainingMs())
        return { code: 0, stdout: "domovoi-task:4" }
      }).mockImplementationOnce(async (_command, _args, deadline) => {
        observed.push(deadline.remainingMs())
        return { code: 0, stdout: "domovoi-task:2" }
      }).mockImplementationOnce(async (_command, _args, deadline) => {
        observed.push(deadline.remainingMs())
        expect(effects.remove).not.toHaveBeenCalled()
        return { code: 0, stdout: "domovoi-task:1" }
      }).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:deleted" })
      const pending = removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)
      await vi.advanceTimersByTimeAsync(700)
      await pending

      const plan = windowsTaskRemovalPlan("Domovoi daemon")
      const calls = vi.mocked(effects.capture).mock.calls.map(([, args]) => args)
      expect(isActionRead(calls[0]!)).toBe(true)
      expect(calls.slice(1)).toEqual([
        plan.stop.args, plan.inspect.args, plan.inspect.args, plan.remove.args,
      ])
      const deadlines = vi.mocked(effects.capture).mock.calls.map(([, , deadline]) => deadline)
      expect(deadlines.every((value) => value === deadlines[0])).toBe(true)
      expect(observed).toEqual([29_600, 29_500, 29_400])
      expect(effects.remove).toHaveBeenCalledWith("C:\\Users\\dl\\.domovoi\\service.json", deadlines[0])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each(["0", "3", "missing", "deleted", "Status: Running", "", "1\ndomovoi-task:4"])(
    "retains registration and config when observation returns %j", async (state) => {
      vi.useFakeTimers()
      try {
        const { effects } = taskManager()
        vi.mocked(effects.capture).mockResolvedValueOnce(registered).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:4" })
          .mockResolvedValue({ code: 0, stdout: `domovoi-task:${state}` })
        const pending = expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects))
          .rejects.toThrow('Could not confirm removal of Windows task "Domovoi daemon". Inspect Task Scheduler')
        await vi.advanceTimersByTimeAsync(100)
        await pending
        expect(effects.capture).toHaveBeenCalledTimes(3)
        expect(effects.run).not.toHaveBeenCalled()
        expect(effects.remove).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally { vi.useRealTimers() }
    },
  )

  it.each(["stop", "inspect", "remove"] as const)("preserves config when %s fails", async (phase) => {
    vi.useFakeTimers()
    try {
      const { effects } = taskManager()
      vi.mocked(effects.capture).mockResolvedValueOnce(registered)
      if (phase === "inspect") vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:4" })
      if (phase === "remove") vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:1" })
      vi.mocked(effects.capture).mockResolvedValue({ code: 1, stdout: "", stderr: "Access denied" })
      const pending = expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.toThrow(
        expect.objectContaining({ message: expect.stringMatching(
          /Access denied.*task "Domovoi daemon" may now be disabled.*registration and saved configuration are kept.*schtasks \/change \/tn "Domovoi daemon" \/enable.*domovoid service install/s,
        ) }),
      )
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(effects.remove).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it("treats a task absent before the stop attempt as already removed", async () => {
    const { effects } = taskManager()
    vi.mocked(effects.capture).mockResolvedValue({ code: 0, stdout: "domovoi-task:missing\r\n" })
    await removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)
    // The ownership read, then the stop, each find no task.
    expect(effects.capture).toHaveBeenCalledTimes(2)
    expect(effects.remove).toHaveBeenCalledOnce()
  })

  it("does not treat a disappearing task at deletion as confirmed removal", async () => {
    const { effects } = taskManager()
    vi.mocked(effects.capture).mockResolvedValueOnce(registered).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:1" })
      .mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:missing" })
    await expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.toThrow("registration disappeared")
    expect(effects.remove).not.toHaveBeenCalled()
  })

  it.each(["silent", "running", "queued"] as const)("expires a %s manager without deleting anything or accepting late success", async (mode) => {
    vi.useFakeTimers()
    try {
      const { effects } = taskManager()
      let finish: (value: { code: number; stdout: string }) => void = () => { throw new Error("No pending manager call") }
      const late = new Promise<{ code: number; stdout: string }>((resolve) => { finish = resolve })
      vi.mocked(effects.capture).mockImplementation(async (_command, args) => isActionRead(args) ? registered
        : mode === "silent" ? late : { code: 0, stdout: `domovoi-task:${mode === "running" ? 4 : 2}` })
      const pending = expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects))
        .rejects.toThrow(/Domovoi daemon.*deadline/)
      await vi.advanceTimersByTimeAsync(30_000)
      await pending
      const calls = vi.mocked(effects.capture).mock.calls.length
      expect(calls).toBeGreaterThan(0)
      const deadline = vi.mocked(effects.capture).mock.calls[0]![2]
      expect(deadline).toBeInstanceOf(OperationDeadline)
      expect(deadline.signal.aborted).toBe(true)
      finish({ code: 0, stdout: "domovoi-task:1" })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(effects.capture).toHaveBeenCalledTimes(calls)
      expect(effects.remove).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("keeps task and config when PowerShell is unavailable, without an unregister fallback", async () => {
    const { effects } = taskManager()
    vi.mocked(effects.capture).mockRejectedValue(new Error("spawn powershell.exe ENOENT"))
    await expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.toThrow("powershell.exe ENOENT")
    expect(effects.run).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
  })
})

describe("refusals that never reach Task Scheduler", () => {
  const refusal = (effects: ServiceEffects): Promise<Error> => removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)
    .then(() => { throw new Error("the removal was expected to be refused") }, (error: unknown) => error as Error)

  it("reports service operation exclusion in its own words", async () => {
    const { effects } = taskManager()
    const busy = new ServiceOperationBusyError("C:\\Users\\dl\\.domovoi\\service-operation-lease.sqlite")
    vi.mocked(effects.claimServiceOperation).mockImplementation(() => { throw busy })
    const error = await refusal(effects)
    expect(error).toBe(busy)
    expect(error.message).toBe(busy.message)
    expect(error.message).not.toMatch(/Task Scheduler/)
    expect(effects.capture).not.toHaveBeenCalled()
  })

  it("reports a missing OS directory in its own words", async () => {
    vi.stubEnv("SystemRoot", "")
    const { effects } = taskManager()
    const error = await refusal(effects)
    expect(error.message).toBe("SystemRoot must name the absolute local Windows directory before querying or removing a service")
    expect(error.message).not.toMatch(/Task Scheduler/)
    expect(effects.capture).not.toHaveBeenCalled()
  })

  it("reports profile ownership in its own words once the task is gone", async () => {
    const { task, effects } = taskManager()
    const owned = new ProfileAlreadyOwnedError("C:\\Users\\dl\\.domovoi")
    vi.mocked(effects.claimProfile).mockImplementation(() => { throw owned })
    const error = await refusal(effects)
    expect(error).toBe(owned)
    expect(error.message).toBe(owned.message)
    expect(error.message).not.toMatch(/Task Scheduler/)
    expect(task.registered).toBe(false)
    expect(effects.remove).not.toHaveBeenCalled()
  })
})

describe("Task Scheduler command boundary", () => {
  it("pins the executable to the OS directory instead of searching the working directory", () => {
    vi.stubEnv("SystemRoot", "D:\\System Root")
    const plan = windowsTaskRemovalPlan("Domovoi daemon")
    for (const command of [plan.stop, plan.inspect, plan.remove]) {
      expect(command.command).toBe("D:\\System Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    }
  })

  it.each([undefined, "", "Windows", "D:Windows", "\\Windows", "\\\\host\\Windows"])(
    "refuses a missing or nonlocal OS directory %j before spawning anything", async (root) => {
      vi.stubEnv("SystemRoot", root)
      const { effects } = taskManager()
      await expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.toThrow("SystemRoot")
      await expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.not.toThrow("/enable")
      expect(effects.capture).not.toHaveBeenCalled()
      expect(effects.run).not.toHaveBeenCalled()
      expect(effects.remove).not.toHaveBeenCalled()
    },
  )

  it("uses a noninteractive encoded script and quotes task names as data", () => {
    const name = "a'; throw 'not a command"
    const plan = windowsTaskRemovalPlan(name)
    for (const command of [plan.stop, plan.inspect, plan.remove]) {
      expect(command.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      expect(command.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
      const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
      expect(script).toContain("$name = 'a''; throw ''not a command'")
      expect(script).toContain("$ErrorActionPreference = 'Stop'")
      expect(script).toContain(".HResult -eq -2147024894")
      expect(script).not.toContain("-ExecutionPolicy")
    }
    const stop = Buffer.from(plan.stop.args.at(-1)!, "base64").toString("utf16le")
    expect(stop.indexOf("$task.Enabled = $false")).toBeLessThan(stop.indexOf("$task.Stop(0)"))
    expect(stop).toContain(".HResult -ne -2147216629")
    const remove = Buffer.from(plan.remove.args.at(-1)!, "base64").toString("utf16le")
    expect(remove.indexOf("if ([int]$task.State -ne 1)")).toBeLessThan(remove.indexOf("$folder.DeleteTask($name, 0)"))
  })
})

// Owner ruling 2026-09-25: the CLI checks who registered the task, as the
// desktop does. A task under Domovoi's name counts only when service.json holds
// a Domovoi registration and the task runs that file in the shape Domovoi
// writes. An install from before the runtime was recorded stays removable.
describe("the CLI and a same-named Windows task", () => {
  const home = "C:\\Users\\dl"
  const configurationPath = "C:\\Users\\dl\\.domovoi\\service.json"
  const saved: ServiceConfiguration = {
    ...createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
    registrationId: "5f0c7a9e-8a3b-4d1e-9c2f-0a1b2c3d4e5f",
  }

  function scheduler(action: { path: string; arguments: string }, configuration: ServiceConfiguration | undefined) {
    const task = { registered: true, enabled: true, running: true, stopIssued: false }
    const { effects } = taskManager()
    effects.readConfiguration = vi.fn(() => configuration)
    effects.capture = vi.fn(async (_command: string, args: string[]) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (!task.registered) return { code: 0, stdout: "domovoi-task:missing\r\n" }
      const state = task.running ? 4 : task.enabled ? 3 : 1
      if (script.includes("domovoi-task-action:")) {
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify({ ...action, enabled: task.enabled, state })}\r\n` }
      }
      if (script.includes("$task.Enabled = $false")) { task.enabled = false; task.stopIssued = true }
      if (script.includes("$task.Stop(0)")) task.running = false
      if (script.includes("$folder.DeleteTask(")) {
        task.registered = false
        return { code: 0, stdout: "domovoi-task:deleted\r\n" }
      }
      return { code: 0, stdout: `domovoi-task:${task.running ? 4 : task.enabled ? 3 : 1}\r\n` }
    })
    const stdout = vi.fn()
    const stderr = vi.fn()
    const cli = { ...effects, platform: "win32", execPath: "C:\\Domovoi\\index.js", runtime: "C:\\Domovoi\\node.exe", home, stdout, stderr }
    return { task, effects, cli, stdout, stderr }
  }

  const other = { path: "C:\\Tools\\other.exe", arguments: "--serve" }

  it("status reports a task Domovoi did not register as not installed, with the ruled detail", async () => {
    const { cli, stdout } = scheduler(other, undefined)
    expect(await runServiceCommand(["service", "status"], cli)).toBe(1)
    expect(stdout).toHaveBeenCalledWith("not installed, not running: a task named Domovoi daemon exists, but Domovoi did not register it\n")
  })

  it("remove refuses a task Domovoi did not register, before any stop, delete or profile claim", async () => {
    const { task, effects, cli, stdout, stderr } = scheduler(other, undefined)
    expect(await runServiceCommand(["service", "remove"], cli)).toBe(1)
    expect(stderr).toHaveBeenCalledWith('A Windows task named "Domovoi daemon" exists, but Domovoi did not register it. Nothing was stopped or deleted.\n')
    expect(stdout).not.toHaveBeenCalled()
    expect(task).toEqual({ registered: true, enabled: true, running: true, stopIssued: false })
    expect(effects.claimProfile).not.toHaveBeenCalled()
    expect(effects.remove).not.toHaveBeenCalled()
  })

  // Neither install records its runtime in service.json: one ran the entry
  // through Node, the other ran one program.
  it.each([
    ["a runtime and an entry", { path: '"C:\\Program Files\\nodejs\\node.exe"', arguments: `"C:\\Users\\dl\\AppData\\Roaming\\npm\\domovoi\\dist\\index.js" --service-config "${configurationPath}"` }],
    ["one program", { path: "C:\\Domovoi\\domovoid.exe", arguments: `--service-config "${configurationPath}"` }],
  ])("remove still removes an older install that runs %s", async (_shape, action) => {
    const { task, effects, cli, stdout, stderr } = scheduler(action, saved)
    expect(await runServiceCommand(["service", "remove"], cli)).toBe(0)
    expect(stderr).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith("Removed the Domovoi daemon service Domovoi daemon\n")
    expect(task.registered).toBe(false)
    expect(effects.remove).toHaveBeenCalledWith(configurationPath, expect.anything())
  })
})

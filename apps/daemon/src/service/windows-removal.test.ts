import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { removeService, runServiceCommand, type ServiceEffects } from "./install.js"
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

// Model the OS boundary, not a mock which assumes unregistering kills a task.
// Microsoft's /delete contract explicitly leaves running programs alone.
function taskManager() {
  const task = { registered: true, enabled: true, running: true }
  const effects: ServiceEffects = {
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
      vi.mocked(effects.capture).mockImplementationOnce(async (_command, _args, deadline) => {
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
      expect(vi.mocked(effects.capture).mock.calls.map(([, args]) => args)).toEqual([
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
        vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:4" })
          .mockResolvedValue({ code: 0, stdout: `domovoi-task:${state}` })
        const pending = expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects))
          .rejects.toThrow('Could not confirm removal of Windows task "Domovoi daemon". Inspect Task Scheduler')
        await vi.advanceTimersByTimeAsync(100)
        await pending
        expect(effects.capture).toHaveBeenCalledTimes(2)
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
      if (phase === "inspect") vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:4" })
      if (phase === "remove") vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:1" })
      vi.mocked(effects.capture).mockResolvedValue({ code: 1, stdout: "", stderr: "Access denied" })
      const pending = expect(removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)).rejects.toThrow("Access denied")
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
    expect(effects.capture).toHaveBeenCalledOnce()
    expect(effects.remove).toHaveBeenCalledOnce()
  })

  it("does not treat a disappearing task at deletion as confirmed removal", async () => {
    const { effects } = taskManager()
    vi.mocked(effects.capture).mockResolvedValueOnce({ code: 0, stdout: "domovoi-task:1" })
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
      vi.mocked(effects.capture).mockImplementation(async () => mode === "silent" ? late : { code: 0, stdout: `domovoi-task:${mode === "running" ? 4 : 2}` })
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

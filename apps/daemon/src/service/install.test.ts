import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import * as filesystem from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OperationDeadline } from "../operation-deadline.js"
import { createProductionDaemon } from "../production-daemon.js"
import { createServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { removeScratchDirectory } from "../test-scratch.js"

import {
  installService,
  nodeServiceEffects,
  removeService,
  runServiceCommand,
  serviceRemovalPlan,
  serviceStatus,
  servicePlan,
  type CapturedRun,
  type ServiceCommandDependencies,
  type ServiceEffects,
} from "./install.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

function configuration(homeDirectory: string, platform: string) {
  return createServiceConfiguration({}, { homeDirectory, platform, workingDirectory: homeDirectory })
}
const linux = { platform: "linux", execPath: "/usr/local/bin/domovoid", home: "/home/dl", uid: 1000, user: "dl", configuration: configuration("/home/dl", "linux") }
const darwin = { platform: "darwin", execPath: "/usr/local/bin/domovoid", home: "/Users/dl", uid: 501, configuration: configuration("/Users/dl", "darwin") }
const windows = { platform: "win32", execPath: "C:\\Program Files\\Domovoi\\domovoid.exe", user: "dl", home: "C:\\Users\\dl", configuration: configuration("C:\\Users\\dl", "win32") }
// Ruled 2026-09-25: Windows status and removal first read the task's action
// and service.json to check that Domovoi registered the task. This answers
// that read with a Domovoi registration and leaves every other script to the
// test.
function registeredWindowsTask(answer: (command: string, args: string[]) => Promise<CapturedRun> | CapturedRun): Partial<ServiceEffects> {
  const configurationPath = "C:\\Users\\dl\\.domovoi\\service.json"
  const action = { path: "C:\\Program Files\\nodejs\\node.exe", arguments: `"C:\\Program Files\\Domovoi\\dist\\index.js" --service-config "${configurationPath}"`, enabled: true, state: 4 }
  return {
    readConfiguration: vi.fn(() => ({ ...windows.configuration, serviceRuntime: { executable: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\Program Files\\Domovoi\\dist\\index.js" } })),
    capture: vi.fn(async (command: string, args: string[]) => {
      const script = command === "schtasks" ? "" : Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (script.includes("domovoi-task-action:")) return { code: 0, stdout: `domovoi-task-action:${JSON.stringify(action)}\r\n` }
      return answer(command, args)
    }),
  }
}
const windowsScript = {
  platform: "win32",
  execPath: "C:\\Program Files\\Domovoi\\dist\\index.js",
  runtime: "C:\\Program Files\\nodejs\\node.exe",
  user: "dl",
  home: windows.home,
  configuration: windows.configuration,
}

function effects(overrides: Partial<ServiceEffects> = {}): ServiceEffects {
  return {
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    capture: vi.fn(async () => ({ code: 0, stdout: "" })),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(() => { vi.unstubAllEnvs() })

// Security review round 3: a darwin or Windows install first asks the manager
// what is registered under Domovoi's name. These answer that nothing is. A
// Linux install asks loginctl about lingering; this answers that it is
// already on, so nothing is changed (Linux lingering, below).
const nothingRegistered = () => vi.fn(async (command: string) => command === "launchctl"
  ? { code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501' }
  : command.endsWith("powershell.exe") ? { code: 0, stdout: "domovoi-task:missing\r\n" }
    : command === "loginctl" ? { code: 0, stdout: "yes\n" } : { code: 0, stdout: "" })

function command(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
  vi.stubEnv("SystemRoot", "C:\\Windows")
  return {
    ...effects({ capture: nothingRegistered() }),
    platform: "linux",
    execPath: "/usr/local/bin/domovoid",
    home: "/home/dl",
    // The simulated target owns its path syntax, not the machine running Vitest.
    workingDirectory: overrides.home ?? "/home/dl",
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  }
}

describe("servicePlan", () => {
  // The Windows plan names PowerShell under SystemRoot for its settings step.
  beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })

  // Review F3: a bare schtasks is looked up in the working directory first on
  // Windows, so a repository could supply its own. Every schtasks call names
  // the one under SystemRoot, as PowerShell and taskkill already do.
  it("runs schtasks from the Windows directory, never by a searched name", () => {
    vi.stubEnv("SystemRoot", "D:\\Windows")
    const plan = servicePlan(windowsScript)
    expect(plan.commands.filter(({ args }) => args[0] === "/create" || args[0] === "/run").map(({ command }) => command))
      .toEqual(["D:\\Windows\\System32\\schtasks.exe", "D:\\Windows\\System32\\schtasks.exe"])
    for (const root of ["", "Windows", "\\\\host\\Windows"]) {
      vi.stubEnv("SystemRoot", root)
      expect(() => servicePlan(windowsScript)).toThrow("SystemRoot must name the absolute local Windows directory")
    }
  })

  // schtasks /create refuses a /tr value over 261 characters with "Value for
  // '/TR' option cannot be more than 261 character(s)", one fewer than its
  // documentation's 262. With this runtime and configuration, an entry of
  // 168 characters makes the command exactly 261.
  const entryOfLength = (length: number) => `C:\\${"a".repeat(length - 17)}\\dist\\index.js`

  it("registers a Windows task command of 261 characters, the most schtasks accepts", () => {
    const plan = servicePlan({ ...windowsScript, execPath: entryOfLength(168) })
    const create = plan.commands.find(({ args }) => args[0] === "/create")!
    const command = create.args[create.args.indexOf("/tr") + 1]!
    expect(command).toBe(`"C:\\Program Files\\nodejs\\node.exe" "${entryOfLength(168)}" --service-supervise "C:\\Users\\dl\\.domovoi\\service.json"`)
    expect(command).toHaveLength(261)
  })

  it("refuses a 262 character Windows command before any files or manager calls, naming its longest part", async () => {
    const dependencies = effects()
    await expect(installService({ ...windowsScript, execPath: entryOfLength(169) }, dependencies)).rejects.toThrow(
      `The Windows task command is 262 characters, and schtasks accepts at most 261. Its longest part is the daemon entry ${entryOfLength(169)} (169 characters). Install Node and Domovoi at shorter absolute paths before installing the service. No service files were changed.`,
    )
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
  })

  it("names the Node runtime when it is the longest part of an overlong Windows command", () => {
    const runtime = `C:\\${"n".repeat(200)}\\node.exe`
    expect(() => servicePlan({ ...windowsScript, runtime })).toThrow(
      `The Windows task command is 311 characters, and schtasks accepts at most 261. Its longest part is the Node runtime ${runtime} (212 characters).`,
    )
  })

  it("puts a systemd unit in the asking user's own configuration", () => {
    const plan = servicePlan(linux)
    expect(plan).toMatchObject({
      kind: "file",
      path: "/home/dl/.config/systemd/user/domovoid.service",
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", "domovoid.service"] },
      ],
    })
    expect(plan.kind === "file" && plan.contents).toContain("ExecStart=/usr/local/bin/domovoid")
  })

  it("puts a launch agent in the asking user's own LaunchAgents", () => {
    const plan = servicePlan(darwin)
    expect(plan).toMatchObject({
      kind: "file",
      path: "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist",
      commands: [{
        command: "launchctl",
        args: ["bootstrap", "gui/501", "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"],
      }],
    })
  })

  it("registers a Windows logon task for the asking user rather than a machine service", () => {
    const plan = servicePlan(windows)
    expect(plan.kind).toBe("task")
    expect(plan.commands[0]).toMatchObject({
      command: "C:\\Windows\\System32\\schtasks.exe",
      args: expect.arrayContaining(["/create", "/ru", "dl", "/rl", "LIMITED", "/sc", "onlogon"]),
    })
    expect(plan.commands[0]?.args).not.toContain("HIGHEST")
  })

  it("launches a script through Node rather than letting Windows pick an interpreter", () => {
    const plan = servicePlan(windowsScript)
    const target = plan.commands[0]?.args[plan.commands[0].args.indexOf("/tr") + 1]
    expect(target).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Domovoi\\dist\\index.js" --service-supervise "C:\\Users\\dl\\.domovoi\\service.json"')
  })

  // The daemon runs for the whole logon session. schtasks /create
  // keeps Task Scheduler's defaults, a 72 hour execution limit and stops on
  // battery, so a step right after it sets what the WSL task sets
  // (wsl-task.ts), before the task is run.
  it("lifts the execution limit and battery stops before running the task", () => {
    const plan = servicePlan(windowsScript)
    expect(plan.commands.map(({ command, args }) => command.endsWith("\\schtasks.exe") ? args[0] : command)).toEqual([
      "/create", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "/run",
    ])
    const settings = plan.commands[1]!
    expect(settings.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    const script = Buffer.from(settings.args.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("$name = 'Domovoi daemon'")
    for (const line of ["$definition.Settings.ExecutionTimeLimit = 'PT0S'", "$definition.Settings.DisallowStartIfOnBatteries = $false", "$definition.Settings.StopIfGoingOnBatteries = $false"]) {
      expect(script).toContain(line)
    }
    // TASK_UPDATE (4), under the task's own principal and logon type.
    expect(script).toContain("$folder.RegisterTaskDefinition($name, $definition, 4, $definition.Principal.UserId, $null, [int]$definition.Principal.LogonType, $null)")
  })

  it("passes a real executable straight through", () => {
    const plan = servicePlan(windows)
    const target = plan.commands[0]?.args[plan.commands[0].args.indexOf("/tr") + 1]
    expect(target).toBe('"C:\\Program Files\\Domovoi\\domovoid.exe" --service-supervise "C:\\Users\\dl\\.domovoi\\service.json"')
  })

  it("refuses a script with no runtime to run it", () => {
    const { runtime: _runtime, ...withoutRuntime } = windowsScript
    expect(() => servicePlan(withoutRuntime))
      .toThrow("a Windows task that runs a script needs the Node executable that runs it")
  })

  it("refuses a platform with no service manager it knows", () => {
    expect(() => servicePlan({ ...linux, platform: "aix" }))
      .toThrow("aix has no service manager this knows how to install into")
  })

  it("refuses a logon task whose user or executable could break out of its quoting", () => {
    expect(() => servicePlan({ ...windows, user: 'dl" /rl HIGHEST' }))
      .toThrow("the logon task needs the user it runs as")
    expect(() => servicePlan({ ...windows, execPath: 'C:\\a" /tr calc.exe' }))
      .toThrow("is not an absolute path to domovoid")
  })
})

describe("installService", () => {
  it("refuses before installing anything while Desktop owns the canonical profile", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-install-owned-"))
    const desktop = await createProductionDaemon({ homeDirectory, environment: {}, owner: "desktop" })
    const dependencies = { ...nodeServiceEffects({ userHomeDirectory: homeDirectory }), write: vi.fn(async () => {}), run: vi.fn(async () => {}) }
    try {
      await expect(installService({
        ...linux, home: homeDirectory, configuration: configuration(homeDirectory, process.platform),
      }, dependencies)).rejects.toThrow(/Close Desktop.*start the service.*reopen Desktop/)
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(dependencies.run).not.toHaveBeenCalled()
    } finally {
      await desktop.stop()
      await removeScratchDirectory(homeDirectory)
    }
  })
  it("keeps the last complete configuration when a replacement write fails partway", async () => {
    const deadline = OperationDeadline.start(5_000)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const directory = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-replace-")))
    const path = join(directory, "service.json")
    const originalWrite = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile
    try {
      await within(() => originalWrite(path, "previous complete settings"))
      vi.mocked(filesystem.writeFile).mockImplementationOnce(async (target, _contents, options) => {
        await originalWrite(target, "partial replacement", options)
        throw new Error("injected partial write")
      })
      await expect(within(() => nodeServiceEffects().write(path, "replacement settings", deadline)))
        .rejects.toThrow(/injected partial write/)
      expect(await within(() => readFile(path, "utf8"))).toBe("previous complete settings")
      expect(await within(() => filesystem.readdir(directory))).toEqual(["service.json"])
    } finally {
      vi.mocked(filesystem.writeFile).mockImplementation(originalWrite)
      await removeScratchDirectory(directory)
      deadline.clear()
    }
  })

  // Windows MoveFileEx refuses to replace service.json while the supervisor or
  // a status read holds it open.
  it("retries a Windows sharing refusal when replacing a service file", async () => {
    const deadline = OperationDeadline.start(5_000)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const directory = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-sharing-")))
    const path = join(directory, "service.json")
    const refusal = (code: string) => Object.assign(new Error(`${code}: rename refused`), { code, syscall: "rename" })
    const real = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      await within(() => writeFile(path, "previous complete settings"))
      vi.mocked(filesystem.rename).mockClear().mockRejectedValueOnce(refusal("EPERM")).mockRejectedValueOnce(refusal("EACCES"))
      Object.defineProperty(process, "platform", { ...real, value: "win32" })
      try { await within(() => nodeServiceEffects().write(path, "replacement settings", deadline)) }
      finally { Object.defineProperty(process, "platform", real) }
      expect(await within(() => readFile(path, "utf8"))).toBe("replacement settings")
      expect(filesystem.rename).toHaveBeenCalledTimes(3)
      expect(await within(() => filesystem.readdir(directory))).toEqual(["service.json"])
    } finally {
      vi.mocked(filesystem.rename).mockReset()
      await removeScratchDirectory(directory)
      deadline.clear()
    }
  })

  it("honors every injected service effect", () => {
    const write = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const dependencies = effects({ write, remove })
    expect(dependencies.write).toBe(write)
    expect(dependencies.remove).toBe(remove)
  })

  it.skipIf(process.platform === "win32")("tightens existing service settings before starting the manager", async () => {
    const deadline = OperationDeadline.start(5_000)
    const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
    const directory = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-permissions-")))
    try {
      const path = join(directory, "service.json")
      await within(() => writeFile(path, "old settings"))
      await within(() => chmod(path, 0o666))
      await within(() => chmod(directory, 0o777))
      await within(() => nodeServiceEffects().write(path, "new settings", deadline))
      expect((await within(() => stat(path))).mode & 0o777).toBe(0o600)
      expect((await within(() => stat(directory))).mode & 0o777).toBe(0o700)
      expect(await within(() => readFile(path, "utf8"))).toBe("new settings")
    } finally {
      await removeScratchDirectory(directory)
      deadline.clear()
    }
  })

  it("uses one deadline for every install step", async () => {
    const dependencies = effects()
    await installService(linux, dependencies)
    const deadline = vi.mocked(dependencies.write).mock.calls[0]?.[2]
    expect(deadline).toBeInstanceOf(OperationDeadline)
    expect(vi.mocked(dependencies.write).mock.calls.every((call) => call[2] === deadline)).toBe(true)
    expect(vi.mocked(dependencies.run).mock.calls.every((call) => call[2] === deadline)).toBe(true)
  })

  it("expires a stalled config write without running later install steps", async () => {
    vi.useFakeTimers()
    let finishWrite: () => void = () => {}
    try {
      const write = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
      const run = vi.fn(async () => {})
      const installing = installService(linux, { ...effects(), write, run })
      const rejection = expect(installing).rejects.toThrow(/deadline/)
      await vi.advanceTimersByTimeAsync(30_000)
      await rejection
      finishWrite()
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledTimes(1)
      expect(run).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes the unit before asking the manager to load it", async () => {
    const order: string[] = []
    const written = vi.fn(async () => { order.push("write") })
    const ran = vi.fn(async () => { order.push("run") })
    await installService(linux, { ...effects(), write: written, run: ran })
    expect(order).toEqual(["write", "write", "run", "run"])
  })

  it("does not run the manager when the unit cannot be written", async () => {
    const ran = vi.fn(async () => {})
    await expect(installService(linux, {
      ...effects(),
      write: async () => { throw new Error("read-only file system") },
      run: ran,
    })).rejects.toThrow("read-only file system")
    expect(ran).not.toHaveBeenCalled()
  })
})

describe("service operation lease lifecycle", () => {
  const invoke = (verb: "install" | "remove" | "status", dependencies: ServiceEffects): Promise<unknown> =>
    verb === "install" ? installService(linux, dependencies)
      : verb === "remove" ? removeService(linux, dependencies) : serviceStatus(linux, dependencies)

  it.each(["install", "remove", "status"] as const)("releases %s exclusion after success or a settled error", async (verb) => {
    const release = vi.fn()
    const dependencies = effects({ claimServiceOperation: vi.fn(() => ({ release })) })
    await invoke(verb, dependencies)
    expect(release).toHaveBeenCalledOnce()
    vi.mocked(dependencies.run).mockRejectedValue(new Error("manager refused"))
    vi.mocked(dependencies.capture).mockRejectedValue(new Error("manager refused"))
    await expect(invoke(verb, dependencies)).rejects.toThrow("manager refused")
    expect(release).toHaveBeenCalledTimes(2)
  })

  it.each(["install", "remove", "status"] as const)("retains %s exclusion after expiry and ignores late completion", async (verb) => {
    vi.useFakeTimers()
    try {
      let finish = () => {}
      const pending = new Promise<void>((resolve) => { finish = resolve })
      const release = vi.fn()
      const dependencies = effects({
        claimServiceOperation: vi.fn(() => ({ release })),
        run: vi.fn(() => pending),
        capture: vi.fn(async () => { await pending; return { code: 0, stdout: "active" } }),
      })
      const rejected = expect(invoke(verb, dependencies)).rejects.toThrow(/deadline/)
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(release).not.toHaveBeenCalled()
      const calls = [dependencies.run, dependencies.capture, dependencies.write, dependencies.remove]
        .map((operation) => vi.mocked(operation).mock.calls.length)
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect([dependencies.run, dependencies.capture, dependencies.write, dependencies.remove]
        .map((operation) => vi.mocked(operation).mock.calls.length)).toEqual(calls)
      expect(release).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("starts the deadline before acquisition and rejects a late claim before any work", async () => {
    let now = 0
    const deadline = OperationDeadline.start(30_000, { now: () => now })
    const start = vi.spyOn(OperationDeadline, "start").mockReturnValue(deadline)
    const release = vi.fn()
    try {
      const dependencies = effects({ claimServiceOperation: vi.fn(() => { now = 30_000; return { release } }) })
      await expect(installService(linux, dependencies)).rejects.toThrow(/deadline/)
      expect(start).toHaveBeenCalledOnce()
      expect(dependencies.claimProfile).not.toHaveBeenCalled()
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(dependencies.remove).not.toHaveBeenCalled()
      expect(dependencies.run).not.toHaveBeenCalled()
    } finally { start.mockRestore(); deadline.clear() }
  })

  it("checks elapsed time when a manager rejects before the timer callback runs", async () => {
    let now = 0
    const deadline = OperationDeadline.start(30_000, { now: () => now })
    const start = vi.spyOn(OperationDeadline, "start").mockReturnValue(deadline)
    const release = vi.fn()
    try {
      const dependencies = effects({
        claimServiceOperation: vi.fn(() => ({ release })),
        run: vi.fn(async () => { now = 30_000; throw new Error("manager rejected late") }),
      })
      await expect(installService(linux, dependencies)).rejects.toThrow("manager rejected late")
      expect(release).not.toHaveBeenCalled()
      expect(deadline.signal.aborted).toBe(true)
    } finally { start.mockRestore(); deadline.clear() }
  })
})

describe("serviceRemovalPlan", () => {
  it("stops the service before naming the file to delete", () => {
    expect(serviceRemovalPlan({ platform: "linux", home: "/home/dl" })).toEqual({
      kind: "file",
      path: "/home/dl/.config/systemd/user/domovoid.service",
      contents: "",
      commands: [
        { command: "systemctl", args: ["--user", "disable", "--now", "domovoid.service"] },
        { command: "systemctl", args: ["--user", "daemon-reload"] },
      ],
    })
  })

  it("boots the launch agent out by label", () => {
    expect(serviceRemovalPlan({ platform: "darwin", home: "/Users/dl", uid: 501 })).toMatchObject({ commands: [
      { command: "launchctl", args: ["bootout", "gui/501/sh.domovoi.domovoid"] },
    ] })
  })

  it("requires a Windows task stop and observation before removal", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows")
    try {
      const command = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      expect(serviceRemovalPlan({ platform: "win32" })).toEqual({
        kind: "task",
        name: "Domovoi daemon",
        disable: { command, args: expect.any(Array) },
        stop: { command, args: expect.any(Array) },
        inspect: { command, args: expect.any(Array) },
        remove: { command, args: expect.any(Array) },
      })
    } finally { vi.unstubAllEnvs() }
  })
})

describe("removeService", () => {
  it("deletes the unit even when the manager refuses to stop a service it does not know", async () => {
    const dependencies = effects({ run: vi.fn(async () => { throw new Error("Unit not loaded") }) })
    await removeService({ platform: "linux", home: "/home/dl" }, dependencies)
    expect(dependencies.remove).toHaveBeenCalledWith("/home/dl/.config/systemd/user/domovoid.service", expect.any(OperationDeadline))
    expect(dependencies.remove).toHaveBeenCalledWith("/home/dl/.domovoi/service.json", expect.any(OperationDeadline))
  })

  it("leaves the file system alone when there is no unit to delete", async () => {
    const dependencies = effects({ exists: vi.fn(async () => false) })
    await removeService({ platform: "linux", home: "/home/dl" }, dependencies)
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it("keeps the unit when the service manager fails operationally", async () => {
    const dependencies = effects({
      run: vi.fn(async () => { throw new Error("Failed to connect to bus") }),
    })

    await expect(removeService({ platform: "linux", home: "/home/dl" }, dependencies))
      .rejects.toThrow("Failed to connect to bus")
    expect(dependencies.remove).not.toHaveBeenCalled()
  })
})

describe("serviceStatus", () => {
  beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
  afterEach(() => { vi.unstubAllEnvs() })

  it("reports a loaded systemd unit as installed and running", async () => {
    const dependencies = effects({ capture: vi.fn(async () => ({ code: 0, stdout: "active\n" })) })
    await expect(serviceStatus({ platform: "linux", home: "/home/dl" }, dependencies)).resolves.toEqual({
      installed: true,
      running: true,
      detail: "/home/dl/.config/systemd/user/domovoid.service is active",
    })
  })

  it("separates an installed unit from a running one", async () => {
    const dependencies = effects({ capture: vi.fn(async () => ({ code: 3, stdout: "inactive\n" })) })
    await expect(serviceStatus({ platform: "linux", home: "/home/dl" }, dependencies)).resolves.toMatchObject({
      installed: true,
      running: false,
      detail: expect.stringContaining("is inactive"),
    })
  })

  it("reports a missing unit without claiming the manager knows it", async () => {
    const dependencies = effects({
      exists: vi.fn(async () => false),
      capture: vi.fn(async () => ({ code: 4, stdout: "" })),
    })
    await expect(serviceStatus({ platform: "linux", home: "/home/dl" }, dependencies)).resolves.toMatchObject({
      installed: false,
      running: false,
      detail: "no service file at /home/dl/.config/systemd/user/domovoid.service",
    })
  })

  it.each(["running", "not running", "spawn scheduled"])("reports the launch agent's runtime state %j", async (state) => {
    const dependencies = effects({
      capture: vi.fn(async () => ({ code: 0, stdout: `gui/501/sh.domovoi.domovoid = {\n\tpath = /Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist\n\tstate = ${state}\n}\n` })),
    })
    await expect(serviceStatus(darwin, dependencies)).resolves.toEqual({
      installed: true,
      running: state === "running",
      detail: `/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist is loaded (${state})`,
    })
  })

  it("does not borrow a nested launchd state for the agent", async () => {
    const dependencies = effects({ capture: vi.fn(async () => ({
      code: 0,
      stdout: "gui/501/sh.domovoi.domovoid = {\n\tpath = /Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist\n\tresource coalition = {\n\t\tstate = active\n\t}\n\tstate = not running\n}\n",
    })) })
    await expect(serviceStatus(darwin, dependencies)).resolves.toMatchObject({ installed: true, running: false })
  })

  it.each(["", "\t\tstate = running\n", "\tstate = running\n\tstate = not running\n"])(
    "refuses a loaded agent without one unambiguous runtime state: %j", async (stdout) => {
      const dependencies = effects({ capture: vi.fn(async () => ({ code: 0, stdout })) })
      await expect(serviceStatus(darwin, dependencies)).rejects.toThrow("launchctl did not report one agent runtime state")
    },
  )

  it("reports an absent launch agent only on the manager's missing-service answer", async () => {
    const dependencies = effects({
      exists: vi.fn(async () => false),
      capture: vi.fn(async () => ({ code: 113, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid"' })),
    })
    await expect(serviceStatus(darwin, dependencies)).resolves.toMatchObject({ installed: false, running: false })
  })

  it.each([1, 5, 114, 127])("refuses launchctl failure %i even if its text mentions a missing service", async (code) => {
    const dependencies = effects({ capture: vi.fn(async () => ({
      code, stdout: "", stderr: 'Could not find service "sh.domovoi.domovoid"',
    })) })
    await expect(serviceStatus(darwin, dependencies)).rejects.toThrow("Could not find service")
  })

  it.each(["Status: Wird ausgeführt", "Statut : En cours"])("reads numeric Windows state instead of localized schtasks output %j", async (localized) => {
    const dependencies = effects(registeredWindowsTask((command, args) => {
      if (command === "schtasks") return { code: 0, stdout: `${localized}\r\n` }
      expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      expect(script).toContain("[int]$task.State")
      expect(script).not.toMatch(/\$task\.(?:Enabled|Stop)|DeleteTask/)
      return { code: 0, stdout: "domovoi-task:4\r\n" }
    }))
    await expect(serviceStatus({ platform: "win32", home: "C:\\Users\\dl" }, dependencies)).resolves.toEqual({
      installed: true,
      running: true,
      detail: "legacy Windows logon task; no crash supervision or job-object tree evidence",
    })
    // The ownership read, then the state read; neither is schtasks text.
    expect(dependencies.capture).toHaveBeenCalledTimes(2)
    for (const [command, args] of vi.mocked(dependencies.capture).mock.calls) {
      expect(command).not.toMatch(/schtasks/i)
      expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).not.toMatch(/\$task\.Enabled\s*=|\$task\.Stop|DeleteTask/)
    }
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it.each(["1", "2", "3", "missing"])("reports the Windows task answer %j without claiming it is running", async (state) => {
    const dependencies = effects(registeredWindowsTask(() => ({ code: 0, stdout: `domovoi-task:${state}\r\n` })))
    await expect(serviceStatus(windows, dependencies)).resolves.toMatchObject({ installed: state !== "missing", running: false })
  })

  it.each(["domovoi-task:0", "domovoi-task:deleted", "domovoi-task:5", "Status: Running", "", "domovoi-task:4\ndomovoi-task:3"])(
    "refuses an unknown or ambiguous Windows task state %j", async (stdout) => {
      const dependencies = effects(registeredWindowsTask(() => ({ code: 0, stdout })))
      await expect(serviceStatus(windows, dependencies)).rejects.toThrow("Task Scheduler")
    },
  )

  it.each([1, 5, 113, 127])("refuses Task Scheduler failure %i even with a valid state marker", async (code) => {
    const dependencies = effects({ capture: vi.fn(async () => ({ code, stdout: "domovoi-task:4", stderr: "scheduler unavailable" })) })
    await expect(serviceStatus(windows, dependencies)).rejects.toThrow("scheduler unavailable")
  })

  it("preserves a Task Scheduler spawn failure", async () => {
    const failure = Object.assign(new Error("cannot launch PowerShell"), { code: "EIO" })
    const dependencies = effects({ capture: vi.fn(async () => { throw failure }) })
    await expect(serviceStatus(windows, dependencies)).rejects.toBe(failure)
    expect(dependencies.capture).toHaveBeenCalledOnce()
  })

  it("reports an unavailable service manager instead of an inactive service", async () => {
    const dependencies = effects({
      capture: vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "Failed to connect to bus",
      })),
    })

    await expect(serviceStatus({ platform: "linux", home: "/home/dl" }, dependencies))
      .rejects.toThrow("Failed to connect to bus")
  })
})

// Security review round 2 on #574, finding 2: the CLI reports and stops a
// launchd or systemd job only when Domovoi's own file is there.
describe("the CLI and a same-named job with no Domovoi file", () => {
  it("status reports no launch agent, whatever launchctl says is loaded", async () => {
    const dependencies = command({
      ...darwin, execPath: darwin.execPath,
      exists: vi.fn(async () => false),
      capture: vi.fn(async () => ({ code: 0, stdout: "\tpath = /Users/dl/Library/LaunchAgents/other.plist\n\tstate = running\n" })),
    })
    expect(await runServiceCommand(["service", "status"], dependencies)).toBe(1)
    expect(dependencies.stdout).toHaveBeenCalledWith("not installed, not running: no launch agent at /Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist\n")
  })

  it("remove asks no manager to stop a job when Domovoi's unit is not there", async () => {
    for (const target of [darwin, linux]) {
      const dependencies = command({ ...target, exists: vi.fn(async () => false), capture: vi.fn(async () => ({ code: 0, stdout: "active\n" })) })
      expect(await runServiceCommand(["service", "remove"], dependencies)).toBe(0)
      expect(dependencies.run).not.toHaveBeenCalled()
    }
  })
})

// Security review round 5 on #574: the CLI refuses the same Linux paths.
describe("the CLI and systemd expansion characters", () => {
  it("refuses a daemon path containing $ before any file or manager call", async () => {
    const dependencies = command({ ...linux, execPath: "/opt/do$main/domovoid.js", runtime: "/usr/bin/node" })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("/opt/do$main/domovoid.js contains $"))
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
  })
})

describe("runServiceCommand", () => {
  it.each([
    { ...linux, cwd: "/srv/runner", credentialPath: "/srv/runner/relative/daemon.token" },
    { ...darwin, cwd: "/Volumes/runner", credentialPath: "/Volumes/runner/relative/daemon.token" },
    {
      ...windowsScript,
      cwd: "D:\\a\\domovoi\\domovoi\\apps\\daemon",
      credentialPath: "D:\\a\\domovoi\\domovoi\\apps\\daemon\\relative\\daemon.token",
    },
  ])("resolves relative settings against the process cwd on $platform when none is given", async ({ cwd: runnerCwd, credentialPath, ...target }) => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(runnerCwd)
    try {
      const { workingDirectory: _fixtureCwd, ...dependencies } = command({
        ...target,
        environment: { DOMOVOI_CREDENTIAL_PATH: "relative/daemon.token" },
      })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
      expect(dependencies.stderr).not.toHaveBeenCalled()
      const configuration = vi.mocked(dependencies.write).mock.calls.find(([path]) => path.endsWith("service.json"))
      expect(JSON.parse(configuration![1])).toMatchObject({ credentialPath })
    } finally {
      cwd.mockRestore()
    }
  })

  it.each([
    linux,
    darwin,
    { ...windowsScript, home: "C:\\Users\\dl" },
  ])("preserves non-default daemon configuration on $platform", async (target) => {
    const root = target.home
    const separator = target.platform === "win32" ? "\\" : "/"
    const at = (name: string) => `${root}${separator}${name}`
    const dependencies = command({
      ...target,
      environment: {
        DOMOVOI_HOST: "0.0.0.0",
        DOMOVOI_PORT: "7717",
        DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
        DOMOVOI_TLS_CERT_PATH: at("cert.pem"),
        DOMOVOI_TLS_KEY_PATH: at("private.key"),
        DOMOVOI_CREDENTIAL_PATH: at("daemon.token"),
        DOMOVOI_MACHINE_IDENTITY_PATH: at("machine.json"),
        DOMOVOI_ADVERTISE_HOST: "studio.example.com",
        DOMOVOI_ALLOWED_ORIGINS: "https://domovoi.example.com",
      },
    })

    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    const configuration = vi.mocked(dependencies.write).mock.calls.find(([path]) => path.endsWith("service.json"))
    expect(configuration, "the supervised launch must carry a configuration file").toBeDefined()
    expect(JSON.parse(configuration![1])).toEqual({
      profileDirectory: at(".domovoi"),
      version: 1,
      registrationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      homeDirectory: root,
      host: "0.0.0.0",
      port: 7717,
      allowRemoteTransport: true,
      tls: { certPath: at("cert.pem"), keyPath: at("private.key") },
      credentialPath: at("daemon.token"),
      machineIdentityPath: at("machine.json"),
      advertiseHost: "studio.example.com",
      allowedOrigins: ["https://domovoi.example.com"],
      // Ruled 2026-09-24 (A): a service that runs a script through a named
      // runtime records both, so an update can put back only those.
      ...("runtime" in target ? { serviceRuntime: { executable: target.runtime, entry: target.execPath } } : {}),
      // Lingering was already on (nothingRegistered), so not Domovoi's.
      ...(target.platform === "linux" ? { lingerEnabledByDomovoi: false } : {}),
    })
    const launch = target.platform === "win32"
      ? vi.mocked(dependencies.run).mock.calls[0]?.[1].join(" ")
      : vi.mocked(dependencies.write).mock.calls.find(([path]) => !path.endsWith("service.json"))?.[1]
    expect(launch).toContain(target.platform === "win32" ? "--service-supervise" : "--service-config")
    expect(launch).toContain(configuration![0])
  })

  it("rejects an environment-only bearer before writing or installing a service", async () => {
    const dependencies = command({
      ...windowsScript,
      home: "C:\\Users\\dl",
      environment: { DOMOVOI_AUTH_TOKEN: "s".repeat(43) },
    })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("DOMOVOI_CREDENTIAL_PATH"))
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
  })

  it("installs and says where the service went", async () => {
    const dependencies = command()
    await expect(runServiceCommand(["service", "install"], dependencies)).resolves.toBe(0)
    expect(dependencies.stdout).toHaveBeenCalledWith(
      "Installed the Domovoi daemon service at /home/dl/.config/systemd/user/domovoid.service\n",
    )
  })

  it("removes and says what went away", async () => {
    const dependencies = command()
    await expect(runServiceCommand(["service", "remove"], dependencies)).resolves.toBe(0)
    expect(dependencies.stdout).toHaveBeenCalledWith(
      "Removed the Domovoi daemon service at /home/dl/.config/systemd/user/domovoid.service\n",
    )
  })

  it("exits non-zero when status finds nothing installed", async () => {
    const dependencies = command({
      exists: vi.fn(async () => false),
      capture: vi.fn(async () => ({ code: 4, stdout: "" })),
    })
    await expect(runServiceCommand(["service", "status"], dependencies)).resolves.toBe(1)
    expect(dependencies.stdout).toHaveBeenCalledWith(
      "not installed, not running: no service file at /home/dl/.config/systemd/user/domovoid.service\n",
    )
  })

  it("reports what the service manager said instead of inventing a success", async () => {
    const dependencies = command({ run: vi.fn(async () => { throw new Error("Failed to connect to bus") }) })
    await expect(runServiceCommand(["service", "install"], dependencies)).resolves.toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Failed to connect to bus\n")
    expect(dependencies.stdout).not.toHaveBeenCalled()
  })

  it.each([["service"], ["service", "restart"], ["service", "install", "--now"]])(
    "prints usage for %s",
    async (...args: string[]) => {
      const dependencies = command()
      await expect(runServiceCommand(args, dependencies)).resolves.toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: domovoid service install"))
    },
  )

  it("declines an argument list that is not a service command", async () => {
    const dependencies = command()
    await expect(runServiceCommand(["pair"], dependencies)).resolves.toBe(1)
    expect(dependencies.stderr).not.toHaveBeenCalled()
  })

  it("uses supplied command words in service usage", async () => {
    const dependencies = command({ words: {
      install: "custom install", status: "custom status", remove: "custom remove", profileRecover: "custom recover",
    } })
    expect(await runServiceCommand(["service"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Usage: custom install\n       custom status\n       custom remove\n")
  })
})

// A reinstall over the logon task Domovoi registered replaces it with the
// schtasks under SystemRoot and lifts Task Scheduler's run limit and battery
// stops before running it. Every Task Scheduler answer here is mocked.
it("reinstalls over the logon task Domovoi registered, lifting its run limit before it runs", async () => {
  vi.stubEnv("SystemRoot", "C:\\Windows")
  const configurationPath = "C:\\Users\\dl\\.domovoi\\service.json"
  const action = { path: "C:\\Program Files\\nodejs\\node.exe", arguments: `"C:\\Program Files\\Domovoi\\dist\\index.js" --service-supervise "${configurationPath}"`, enabled: true, state: 3 }
  const dependencies = effects({
    stopSupervisor: vi.fn(async (_path, _deadline, options) => {
      if (!await options?.stopTask?.()) throw new Error("Task remains observable")
    }),
    supervisorStatus: vi.fn(async () => ({ installed: true, running: false, supervising: false, detail: "stopped; jobs empty" })),
    readConfiguration: vi.fn(() => ({ ...windows.configuration, serviceRuntime: { executable: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\Program Files\\Domovoi\\dist\\index.js" } })),
    capture: vi.fn(async (_command, args) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (script.includes("domovoi-task-action:")) return { code: 0, stdout: `domovoi-task-action:${JSON.stringify(action)}` }
      if (script.includes("$task.Enabled = $false")) { action.enabled = false; action.state = 1 }
      return { code: 0, stdout: `domovoi-task:${action.state}` }
    }),
  })
  await expect(installService(windowsScript, dependencies)).resolves.toMatchObject({ kind: "task" })
  expect(vi.mocked(dependencies.run).mock.calls.map(([command, args]) => command === "C:\\Windows\\System32\\schtasks.exe" ? args[0] : "settings")).toEqual(["/create", "settings", "/run"])
})

// Decided 2026-09-17 (SHIP-PLAN S1.1): a Linux install turns lingering on and
// records that Domovoi did; removal turns it off only on that record. Every
// loginctl call here is answered by the mocked command runner; none runs.
describe("Linux lingering", () => {
  type Answers = { state?: CapturedRun | Error; enable?: CapturedRun; disable?: CapturedRun }
  function loginctl(answers: Answers = {}, order: string[] = []) {
    return vi.fn(async (name: string, args: string[]): Promise<CapturedRun> => {
      if (name !== "loginctl") return { code: 0, stdout: "" }
      order.push(`loginctl ${args[0]}`)
      if (args[0] === "show-user") {
        if (answers.state instanceof Error) throw answers.state
        return answers.state ?? { code: 0, stdout: "no\n" }
      }
      if (args[0] === "enable-linger") return answers.enable ?? { code: 0, stdout: "" }
      if (args[0] === "disable-linger") return answers.disable ?? { code: 0, stdout: "" }
      throw new Error(`unexpected loginctl ${args.join(" ")}`)
    })
  }
  const target = { ...linux, uid: 1000, user: "dl" }
  const saved = (dependencies: ServiceEffects) => JSON.parse(vi.mocked(dependencies.write).mock.calls
    .find(([path]) => path.endsWith("service.json"))![1]) as Record<string, unknown>
  const loginctlCalls = (dependencies: ServiceEffects) => vi.mocked(dependencies.capture).mock.calls
    .filter(([name]) => name === "loginctl").map(([, args]) => args)
  const configured = (record: boolean | undefined) => vi.fn(() => ({
    ...linux.configuration, ...(record === undefined ? {} : { lingerEnabledByDomovoi: record }),
  }))

  it("turns lingering on before saving the configuration that records it, and says so", async () => {
    const order: string[] = []
    const dependencies = command({
      ...target,
      capture: loginctl({}, order),
      write: vi.fn(async (path: string) => { order.push(`write ${path}`) }),
      run: vi.fn(async (name: string, args: string[]) => { order.push(`${name} ${args.join(" ")}`) }),
    })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([["show-user", "1000", "--property=Linger", "--value"], ["enable-linger", "1000"]])
    expect(order).toEqual([
      "loginctl show-user", "loginctl enable-linger",
      "write /home/dl/.domovoi/service.json", "write /home/dl/.config/systemd/user/domovoid.service",
      "systemctl --user daemon-reload", "systemctl --user enable --now domovoid.service",
    ])
    expect(saved(dependencies)).toMatchObject({ lingerEnabledByDomovoi: true })
    expect(vi.mocked(dependencies.stdout).mock.calls).toEqual([
      ["Installed the Domovoi daemon service at /home/dl/.config/systemd/user/domovoid.service\n"],
      ["Turned on lingering for dl with loginctl enable-linger, so the daemon keeps running after dl logs out and starts when the machine boots. domovoid service remove turns it off again.\n"],
    ])
    expect(dependencies.stderr).not.toHaveBeenCalled()
  })

  it("leaves lingering that was already on as it was, and records that it was not Domovoi's", async () => {
    const dependencies = command({ ...target, capture: loginctl({ state: { code: 0, stdout: "yes\n" } }) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([["show-user", "1000", "--property=Linger", "--value"]])
    expect(saved(dependencies)).toMatchObject({ lingerEnabledByDomovoi: false })
    expect(dependencies.stdout).toHaveBeenCalledWith("Lingering was already on for dl, so Domovoi left it as it was. domovoid service remove will leave it on.\n")
  })

  it("keeps an earlier install's record that Domovoi turned lingering on", async () => {
    const dependencies = command({
      ...target, readConfiguration: configured(true), capture: loginctl({ state: { code: 0, stdout: "yes\n" } }),
    })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([["show-user", "1000", "--property=Linger", "--value"]])
    expect(saved(dependencies)).toMatchObject({ lingerEnabledByDomovoi: true })
    expect(dependencies.stdout).toHaveBeenCalledWith("Lingering for dl stays on from an earlier Domovoi install. domovoid service remove turns it off again.\n")
  })

  it.each([
    { name: "loginctl missing", answers: { state: { code: 1, stdout: "", stderr: "spawn loginctl ENOENT" } }, detail: "loginctl was not found" },
    { name: "no login manager", answers: { state: { code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory\n" } }, detail: "Failed to connect to bus: No such file or directory" },
    { name: "an unreadable answer", answers: { state: { code: 0, stdout: "maybe\n" } }, detail: "loginctl did not say whether lingering is on" },
    { name: "a refused change", answers: { enable: { code: 1, stdout: "", stderr: "Could not enable linger: Access denied\n" } }, detail: "Could not enable linger: Access denied" },
    { name: "a runner that could not start", answers: { state: new Error("runner refused loginctl") }, detail: "runner refused loginctl" },
  ])("installs and warns plainly with $name, recording nothing", async ({ answers, detail }) => {
    const dependencies = command({ ...target, capture: loginctl(answers) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(vi.mocked(dependencies.run).mock.calls.map(([, args]) => args.join(" "))).toEqual(["--user daemon-reload", "--user enable --now domovoid.service"])
    expect(saved(dependencies)).not.toHaveProperty("lingerEnabledByDomovoi")
    expect(dependencies.stderr).toHaveBeenCalledWith(`Could not turn on lingering for dl: ${detail}. The service is installed, but systemd stops the daemon when dl logs out of every session and starts it again at the next login. To keep it running, run loginctl enable-linger; domovoid service remove will then leave lingering on.\n`)
  })

  // Review of #698 round 4 (P2): loginctl's diagnostic is unbounded, and the
  // app refuses service text over 4,096 UTF-16 units. The diagnostic is
  // shortened, with a marker, before the line is composed, so the CLI and the
  // app print the same bounded line and the logout limit and advice survive.
  it("shortens a long loginctl diagnostic and keeps the logout limit and advice", async () => {
    const diagnostic = `Failed to connect to bus: ${"x".repeat(4_600)}`
    const dependencies = command({ ...target, capture: loginctl({ state: { code: 1, stdout: "", stderr: diagnostic } }) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    const line = vi.mocked(dependencies.stderr).mock.calls.map(([text]) => text).find((text) => text.startsWith("Could not turn on lingering"))!
    expect(line.length).toBeLessThanOrEqual(4_096)
    expect(line).toMatch(/^Could not turn on lingering for dl: Failed to connect to bus: x+\.\.\. \(shortened\)\. The service is installed, but systemd stops the daemon when dl logs out of every session and starts it again at the next login\. To keep it running, run loginctl enable-linger; domovoid service remove will then leave lingering on\.\n$/u)
  })

  it("turns lingering off again when the install puts the previous service files back", async () => {
    const dependencies = command({
      ...target,
      capture: loginctl(),
      read: vi.fn(async () => "previous"),
      run: vi.fn(async () => { throw new Error("Failed to connect to bus") }),
    })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(loginctlCalls(dependencies).map((args) => args[0])).toEqual(["show-user", "enable-linger", "disable-linger"])
    expect(dependencies.stderr).toHaveBeenCalledWith("Failed to connect to bus\n")
  })

  it("says lingering stayed on when turning it off after a failed install also fails", async () => {
    const dependencies = command({
      ...target,
      capture: loginctl({ disable: { code: 1, stdout: "", stderr: "Access denied" } }),
      read: vi.fn(async () => "previous"),
      run: vi.fn(async () => { throw new Error("Failed to connect to bus") }),
    })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Failed to connect to bus. Lingering, which this install turned on, is still on: Access denied. Run loginctl disable-linger if nothing else needs it.\n")
  })

  it("never asks loginctl on macOS or Windows", async () => {
    for (const platform of [darwin, windowsScript]) {
      const capture = nothingRegistered()
      const dependencies = command({ ...platform, capture })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
      expect(capture.mock.calls.some(([name]) => name === "loginctl")).toBe(false)
    }
  })

  it("turns lingering off on removal only after the service files are gone, when Domovoi turned it on", async () => {
    const order: string[] = []
    const dependencies = command({
      ...target,
      readConfiguration: configured(true),
      capture: loginctl({}, order),
      remove: vi.fn(async (path: string) => { order.push(`remove ${path}`) }),
    })
    expect(await runServiceCommand(["service", "remove"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([["disable-linger", "1000"]])
    expect(order).toEqual(["remove /home/dl/.config/systemd/user/domovoid.service", "remove /home/dl/.domovoi/service.json", "loginctl disable-linger"])
    expect(dependencies.stdout).toHaveBeenCalledWith("Turned off lingering for dl, which Domovoi turned on at install.\n")
  })

  it("leaves lingering on at removal when it was on before Domovoi", async () => {
    const dependencies = command({ ...target, readConfiguration: configured(false), capture: loginctl() })
    expect(await runServiceCommand(["service", "remove"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([])
    expect(dependencies.stdout).toHaveBeenCalledWith("Lingering for dl was on before Domovoi was installed, so it was left on.\n")
  })

  it("asks loginctl nothing at removal when no record says Domovoi turned lingering on", async () => {
    const dependencies = command({ ...target, readConfiguration: configured(undefined), capture: loginctl() })
    expect(await runServiceCommand(["service", "remove"], dependencies)).toBe(0)
    expect(loginctlCalls(dependencies)).toEqual([])
    expect(vi.mocked(dependencies.stdout).mock.calls).toEqual([["Removed the Domovoi daemon service at /home/dl/.config/systemd/user/domovoid.service\n"]])
  })

  it("leaves lingering alone when the saved configuration cannot be read at removal", async () => {
    const dependencies = effects({ capture: loginctl(), readConfiguration: vi.fn(() => { throw new Error("Invalid service configuration.") }) })
    await expect(removeService(target, dependencies)).resolves.not.toHaveProperty("linger")
    expect(loginctlCalls(dependencies)).toEqual([])
    expect(dependencies.remove).toHaveBeenCalledWith("/home/dl/.domovoi/service.json", expect.any(OperationDeadline))
  })

  it("finishes the removal and warns when lingering cannot be turned off", async () => {
    const dependencies = command({
      ...target, readConfiguration: configured(true), capture: loginctl({ disable: { code: 1, stdout: "", stderr: "Access denied\n" } }),
    })
    expect(await runServiceCommand(["service", "remove"], dependencies)).toBe(0)
    expect(dependencies.remove).toHaveBeenCalledWith("/home/dl/.domovoi/service.json", expect.any(OperationDeadline))
    expect(dependencies.stderr).toHaveBeenCalledWith("Could not turn off lingering for dl, which Domovoi turned on at install: Access denied. Lingering stays on, so dl's user services keep running after logout. Run loginctl disable-linger if nothing else needs it.\n")
  })
})

import { describe, expect, it, vi } from "vitest"

import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { runServiceCommand, servicePlan, type ServiceCommandDependencies } from "./install.js"

const home = "/home/test"
const registrationId = "12345678-1234-4123-8123-123456789abc"
const wsl = {
  distribution: "Ubuntu", linuxUser: "test",
  powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  wsl: "C:\\Windows\\System32\\wsl.exe",
  executable: "/usr/bin/node", args: ["/opt/domovoi/index.js"],
}
const configuration = { ...createServiceConfiguration({}, { platform: "linux", homeDirectory: home, workingDirectory: home }), registrationId, wsl }

describe("WSL service installation", () => {
  function dependencies() {
    return {
      platform: "linux", home, user: "test", uid: 1000,
      runtime: "/usr/bin/node", execPath: "/opt/domovoi/index.js", workingDirectory: home,
      environment: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop", PATH: "/usr/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0/" },
      readConfiguration: vi.fn(() => undefined),
      claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
      claimProfile: vi.fn(() => ({ release: vi.fn() })),
      removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
      writeRemovalReceipt: vi.fn(), write: vi.fn(async (_path: string, _contents: string) => {}), run: vi.fn(async (_command: string, _args: string[]) => {}),
      capture: vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout:
        args[0] === "-u" ? wsl.powershell : "C:\\Windows" })),
      exists: vi.fn(async () => false), remove: vi.fn(async () => {}),
      stdout: vi.fn(), stderr: vi.fn(),
    }
  }

  it("dispatches a WSL install without consulting systemd", async () => {
    const deps = dependencies()
    expect(await runServiceCommand(["service", "install"], deps)).toBe(0)
    expect(deps.run.mock.calls.some(([command]) => command === "systemctl")).toBe(false)
    const stored = parseServiceConfiguration(deps.write.mock.calls[0]![1]!)
    expect(stored.wsl).toMatchObject({ distribution: "Ubuntu", linuxUser: "test" })
  })

  it("refuses missing Windows interop without writing or falling back", async () => {
    const deps = dependencies()
    delete (deps.environment as Record<string, string | undefined>).WSL_INTEROP
    expect(await runServiceCommand(["service", "install"], deps)).toBe(1)
    expect(deps.write).not.toHaveBeenCalled()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it("ignores a hostile PATH and checks the mounted file before executing it", async () => {
    const deps = dependencies()
    deps.environment.PATH = "/tmp/project/System32/WindowsPowerShell/v1.0"
    expect(await runServiceCommand(["service", "install"], deps)).toBe(0)
    expect(deps.capture.mock.calls.slice(0, 3)).toEqual([
      ["/usr/bin/wslpath", ["-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"], expect.anything()],
      ["/usr/bin/test", ["-f", wsl.powershell], expect.anything()],
      [wsl.powershell, expect.any(Array), expect.anything()],
    ])
    expect(deps.capture.mock.calls.some(([command]) => command.startsWith("/tmp/project/"))).toBe(false)
  })

  it.each([undefined, "/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"])(
    "refuses a missing or non-regular mounted file before Windows execution (%s)", async (override) => {
      const deps = dependencies()
      if (override !== undefined) Object.assign(deps.environment, { DOMOVOI_WINDOWS_POWERSHELL: override })
      deps.capture.mockImplementation(async (command) => command === "/usr/bin/wslpath"
        ? { code: 0, stdout: wsl.powershell } : { code: 1, stdout: "" })
      expect(await runServiceCommand(["service", "install"], deps)).toBe(1)
      expect(deps.capture).toHaveBeenCalledWith("/usr/bin/test", ["-f", override ?? wsl.powershell], expect.anything())
      expect(deps.capture.mock.calls.every(([command]) => command.startsWith("/usr/bin/"))).toBe(true)
      expect(deps.write).not.toHaveBeenCalled()
      expect(deps.run).not.toHaveBeenCalled()
    },
  )

  it.each(["powershell.exe", "C:\\Windows\\powershell.exe", "/tmp/invalid\npath", ""])("refuses invalid override %j before execution", async (override) => {
    const deps = dependencies()
    Object.assign(deps.environment, { DOMOVOI_WINDOWS_POWERSHELL: override })
    expect(await runServiceCommand(["service", "install"], deps)).toBe(1)
    expect(deps.capture).not.toHaveBeenCalled()
    expect(deps.write).not.toHaveBeenCalled()
  })

  it("validates an absolute override and persists its matching host root", async () => {
    const deps = dependencies()
    const override = "/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    Object.assign(deps.environment, { DOMOVOI_WINDOWS_POWERSHELL: override })
    deps.capture.mockImplementation(async (_command, args) => ({ code: 0, stdout: args[0] === "-u" ? override : "D:\\Windows" }))
    expect(await runServiceCommand(["service", "install"], deps)).toBe(0)
    expect(deps.capture.mock.calls[0]).toEqual(["/usr/bin/test", ["-f", override], expect.anything()])
    expect(deps.capture).toHaveBeenCalledWith(override, expect.any(Array), expect.anything())
    expect(parseServiceConfiguration(deps.write.mock.calls[0]![1]!).wsl).toMatchObject({ powershell: override, wsl: "D:\\Windows\\System32\\wsl.exe" })
  })

  it("refuses a regular override whose reported SystemRoot does not match its mount", async () => {
    const deps = dependencies()
    Object.assign(deps.environment, { DOMOVOI_WINDOWS_POWERSHELL: "/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" })
    expect(await runServiceCommand(["service", "install"], deps)).toBe(1)
    expect(deps.write).not.toHaveBeenCalled()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it("keeps an existing registration unchanged on reinstall", async () => {
    const deps: ServiceCommandDependencies = { ...dependencies(), readConfiguration: () => configuration }
    expect(await runServiceCommand(["service", "install"], deps)).toBe(1)
    expect(deps.write).not.toHaveBeenCalled()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it("uses the saved WSL registration for status without shell overrides", async () => {
    const deps: ServiceCommandDependencies = { ...dependencies(), environment: {}, readConfiguration: () => configuration,
      capture: vi.fn(async () => ({ code: 0, stdout: "domovoi-task:4" })),
      supervisorStatus: async () => ({ installed: null, running: true, detail: "guest daemon running" }) }
    expect(await runServiceCommand(["service", "status"], deps)).toBe(0)
    expect(deps.stdout).toHaveBeenCalledWith("installed; guest daemon running\n")
    expect(deps.run).not.toHaveBeenCalled()
  })

  it("keeps existing systemd status and removal reachable inside WSL", async () => {
    const { wsl: _wsl, ...linuxConfiguration } = configuration
    const deps: ServiceCommandDependencies = { ...dependencies(), readConfiguration: () => linuxConfiguration,
      capture: vi.fn(async () => ({ code: 0, stdout: "active" })), exists: async () => true }
    expect(await runServiceCommand(["service", "status"], deps)).toBe(0)
    expect(deps.capture).toHaveBeenCalledWith("systemctl", ["--user", "is-active", "domovoid.service"], expect.anything())
    expect(await runServiceCommand(["service", "remove"], deps)).toBe(0)
    expect(deps.run).toHaveBeenCalledWith("systemctl", ["--user", "disable", "--now", "domovoid.service"], expect.anything())
  })

  it("proves guest shutdown before task deletion and preserves profile data", async () => {
    const events: string[] = []
    const deps: ServiceCommandDependencies = { ...dependencies(), environment: {}, readConfiguration: () => configuration,
      stopSupervisor: async () => { events.push("guest-stop-proof") },
      capture: async (_command, args) => {
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
        const deleting = script.includes("$folder.DeleteTask")
        events.push(deleting ? "task-delete" : "task-disable-stop")
        return { code: 0, stdout: deleting ? "domovoi-task:deleted" : "domovoi-task:1" }
      }, remove: vi.fn(async () => { events.push("configuration-delete") }) }
    expect(await runServiceCommand(["service", "remove"], deps)).toBe(0)
    expect(events).toEqual(["task-disable-stop", "guest-stop-proof", "task-disable-stop", "task-delete", "configuration-delete"])
    expect(deps.remove).toHaveBeenCalledExactlyOnceWith(home + "/.domovoi/service.json", expect.anything())
  })

  it("retains registration after an unknown guest stop", async () => {
    const deps: ServiceCommandDependencies = { ...dependencies(), readConfiguration: () => configuration,
      stopSupervisor: async () => { throw new Error("unresolved guest identity") },
      capture: vi.fn(async () => ({ code: 0, stdout: "domovoi-task:1" })) }
    expect(await runServiceCommand(["service", "remove"], deps)).toBe(1)
    expect(deps.capture).toHaveBeenCalledTimes(1)
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it("persists the selected guest and absolute launch inputs", () => {
    expect(parseServiceConfiguration(serializeServiceConfiguration(configuration))).toEqual(configuration)
  })

  it.each([
    { ...wsl, executable: "node" },
    { ...wsl, powershell: "powershell.exe" },
    { ...wsl, wsl: "wsl.exe" },
    { ...wsl, distribution: "wrong distribution" },
    { ...wsl, linuxUser: "user\nname" },
    { ...wsl, args: Array<string>(17).fill("argument") },
    { ...wsl, unexpected: true },
  ])("refuses invalid saved launch data %#", (invalid) => {
    expect(() => parseServiceConfiguration(JSON.stringify({ ...configuration, wsl: invalid }))).toThrow("Invalid service configuration")
  })

  it("requires a registration identity for a saved WSL manager", () => {
    const { registrationId: _registrationId, ...missing } = configuration
    expect(() => parseServiceConfiguration(JSON.stringify(missing))).toThrow("Invalid service configuration")
  })

  it.each(["domovoi-task:0", "Running", "domovoi-task:4\nextra"])("refuses ambiguous host status %s", async (stdout) => {
    const deps: ServiceCommandDependencies = { ...dependencies(), readConfiguration: () => configuration,
      capture: async () => ({ code: 0, stdout }) }
    expect(await runServiceCommand(["service", "status"], deps)).toBe(1)
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it("selects the guest supervisor task instead of systemd", () => {
    const plan = servicePlan({ platform: "linux", home, execPath: "/opt/domovoi/index.js", runtime: "/usr/bin/node", configuration })
    expect(plan.kind).toBe("task")
    expect(plan.commands.map((entry) => entry.command)).toEqual([wsl.powershell, wsl.powershell])
    const script = Buffer.from(plan.commands[0]!.args.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("--service-supervise")
    expect(script).toContain("--distribution Ubuntu --user test --exec")
    expect(script).toContain("$definition.Settings.RestartCount = 0")
    expect(script).toContain("$definition.Triggers.Create(9)")
  })
})

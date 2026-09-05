import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import * as filesystem from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { OperationDeadline } from "../operation-deadline.js"
import { createServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"

import {
  installService,
  nodeServiceEffects,
  removeService,
  runServiceCommand,
  serviceRemovalPlan,
  serviceStatus,
  servicePlan,
  type ServiceCommandDependencies,
  type ServiceEffects,
} from "./install.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

function configuration(homeDirectory: string, platform: string) {
  return createServiceConfiguration({}, { homeDirectory, platform, workingDirectory: homeDirectory })
}
const linux = { platform: "linux", execPath: "/usr/local/bin/domovoid", home: "/home/dl", configuration: configuration("/home/dl", "linux") }
const darwin = { platform: "darwin", execPath: "/usr/local/bin/domovoid", home: "/Users/dl", uid: 501, configuration: configuration("/Users/dl", "darwin") }
const windows = { platform: "win32", execPath: "C:\\Program Files\\Domovoi\\domovoid.exe", user: "dl", home: "C:\\Users\\dl", configuration: configuration("C:\\Users\\dl", "win32") }
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
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    capture: vi.fn(async () => ({ code: 0, stdout: "" })),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    ...overrides,
  }
}

function command(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
  return {
    ...effects(),
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
  it("refuses an overlong Windows command before any files or manager calls", async () => {
    const dependencies = effects()
    await expect(installService({
      ...windowsScript,
      execPath: `C:\\${"a".repeat(190)}\\dist\\index.js`,
    }, dependencies)).rejects.toThrow(/Windows task command exceeds 262 characters/)
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
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
      command: "schtasks",
      args: expect.arrayContaining(["/create", "/ru", "dl", "/rl", "LIMITED", "/sc", "onlogon"]),
    })
    expect(plan.commands[0]?.args).not.toContain("HIGHEST")
  })

  it("launches a script through Node rather than letting Windows pick an interpreter", () => {
    const plan = servicePlan(windowsScript)
    const target = plan.commands[0]?.args[plan.commands[0].args.indexOf("/tr") + 1]
    expect(target).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Domovoi\\dist\\index.js" --service-config "C:\\Users\\dl\\.domovoi\\service.json"')
  })

  it("passes a real executable straight through", () => {
    const plan = servicePlan(windows)
    const target = plan.commands[0]?.args[plan.commands[0].args.indexOf("/tr") + 1]
    expect(target).toBe('"C:\\Program Files\\Domovoi\\domovoid.exe" --service-config "C:\\Users\\dl\\.domovoi\\service.json"')
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
      await within(() => rm(directory, { recursive: true, force: true }))
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
      await within(() => rm(directory, { recursive: true, force: true }))
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
      const installing = installService(linux, { write, run })
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
    await installService(linux, { write: written, run: ran })
    expect(order).toEqual(["write", "write", "run", "run"])
  })

  it("does not run the manager when the unit cannot be written", async () => {
    const ran = vi.fn(async () => {})
    await expect(installService(linux, {
      write: async () => { throw new Error("read-only file system") },
      run: ran,
    })).rejects.toThrow("read-only file system")
    expect(ran).not.toHaveBeenCalled()
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
    expect(serviceRemovalPlan({ platform: "win32" })).toEqual({
      kind: "task",
      name: "Domovoi daemon",
      stop: { command: "powershell.exe", args: expect.any(Array) },
      inspect: { command: "powershell.exe", args: expect.any(Array) },
      remove: { command: "powershell.exe", args: expect.any(Array) },
    })
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

  it("reads a Windows logon task's own status line", async () => {
    const dependencies = effects({
      capture: vi.fn(async () => ({ code: 0, stdout: "TaskName: Domovoi daemon\r\nStatus: Running\r\n" })),
    })
    await expect(serviceStatus({ platform: "win32" }, dependencies)).resolves.toEqual({
      installed: true,
      running: true,
      detail: "Domovoi daemon is running",
    })
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
      version: 1,
      homeDirectory: root,
      host: "0.0.0.0",
      port: 7717,
      allowRemoteTransport: true,
      tls: { certPath: at("cert.pem"), keyPath: at("private.key") },
      credentialPath: at("daemon.token"),
      machineIdentityPath: at("machine.json"),
      advertiseHost: "studio.example.com",
      allowedOrigins: ["https://domovoi.example.com"],
    })
    const launch = target.platform === "win32"
      ? vi.mocked(dependencies.run).mock.calls[0]?.[1].join(" ")
      : vi.mocked(dependencies.write).mock.calls.find(([path]) => !path.endsWith("service.json"))?.[1]
    expect(launch).toContain("--service-config")
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
})

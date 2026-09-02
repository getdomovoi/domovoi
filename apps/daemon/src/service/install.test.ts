import { describe, expect, it, vi } from "vitest"

import {
  installService,
  removeService,
  runServiceCommand,
  serviceRemovalPlan,
  serviceStatus,
  servicePlan,
  type CapturedRun,
  type ServiceCommandDependencies,
} from "./install.js"

const linux = { platform: "linux", execPath: "/usr/local/bin/domovoid", home: "/home/dl" }
const darwin = { platform: "darwin", execPath: "/usr/local/bin/domovoid", home: "/Users/dl", uid: 501 }
const windows = { platform: "win32", execPath: "C:\\Program Files\\Domovoi\\domovoid.exe", user: "dl" }
const windowsScript = {
  platform: "win32",
  execPath: "C:\\Program Files\\Domovoi\\dist\\index.js",
  runtime: "C:\\Program Files\\nodejs\\node.exe",
  user: "dl",
}

function effects(overrides: Partial<{
  capture: (command: string, args: string[]) => Promise<CapturedRun>
  exists: (path: string) => Promise<boolean>
  run: (command: string, args: string[]) => Promise<void>
}> = {}) {
  return {
    write: vi.fn(async () => {}),
    run: overrides.run ?? vi.fn(async () => {}),
    capture: overrides.capture ?? vi.fn(async () => ({ code: 0, stdout: "" })),
    exists: overrides.exists ?? vi.fn(async () => true),
    remove: vi.fn(async () => {}),
  }
}

function command(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
  return {
    ...effects(),
    platform: "linux",
    execPath: "/usr/local/bin/domovoid",
    home: "/home/dl",
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  }
}

describe("servicePlan", () => {
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
    expect(target).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Domovoi\\dist\\index.js"')
  })

  it("passes a real executable straight through", () => {
    const plan = servicePlan(windows)
    const target = plan.commands[0]?.args[plan.commands[0].args.indexOf("/tr") + 1]
    expect(target).toBe('"C:\\Program Files\\Domovoi\\domovoid.exe"')
  })

  it("refuses a script with no runtime to run it", () => {
    const { runtime: _runtime, ...withoutRuntime } = windowsScript
    expect(() => servicePlan(withoutRuntime))
      .toThrow("a Windows task that runs a script needs the Node executable that runs it")
  })

  it("refuses a platform with no service manager it knows", () => {
    expect(() => servicePlan({ platform: "aix", execPath: "/usr/local/bin/domovoid" }))
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
  it("writes the unit before asking the manager to load it", async () => {
    const order: string[] = []
    const written = vi.fn(async () => { order.push("write") })
    const ran = vi.fn(async () => { order.push("run") })
    await installService(linux, { write: written, run: ran })
    expect(order).toEqual(["write", "run", "run"])
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
    expect(serviceRemovalPlan({ platform: "darwin", home: "/Users/dl", uid: 501 }).commands).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/sh.domovoi.domovoid"] },
    ])
  })

  it("deletes the Windows logon task", () => {
    expect(serviceRemovalPlan({ platform: "win32" })).toEqual({
      kind: "task",
      commands: [{ command: "schtasks", args: ["/delete", "/tn", "Domovoi daemon", "/f"] }],
    })
  })
})

describe("removeService", () => {
  it("deletes the unit even when the manager refuses to stop a service it does not know", async () => {
    const dependencies = effects({ run: vi.fn(async () => { throw new Error("Unit not loaded") }) })
    await removeService({ platform: "linux", home: "/home/dl" }, dependencies)
    expect(dependencies.remove).toHaveBeenCalledWith("/home/dl/.config/systemd/user/domovoid.service")
  })

  it("leaves the file system alone when there is no unit to delete", async () => {
    const dependencies = effects({ exists: vi.fn(async () => false) })
    await removeService({ platform: "linux", home: "/home/dl" }, dependencies)
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
})

describe("runServiceCommand", () => {
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

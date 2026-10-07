import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

import { daemonWorkerEntry, nodeDaemonCommandDependencies, runDaemonCommand } from "./daemon-command.js"
import { systemdUnitProgram } from "./service/units.js"
import type { ServiceCommandDependencies, ServiceEffects } from "./service/install.js"

function effects(overrides: Partial<ServiceEffects> = {}): ServiceEffects {
  return {
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    capture: vi.fn(async (command) => ({ code: 0, stdout: command === "loginctl" ? "yes\n" : "" })),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    ...overrides,
  }
}

function command(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
  return {
    ...effects(),
    platform: "linux",
    execPath: "/opt/domovoi/dist/index.js",
    runtime: "/usr/bin/node",
    home: "/home/dl",
    uid: 1000,
    user: "dl",
    environment: {},
    workingDirectory: "/home/dl",
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  }
}

describe("daemon command", () => {
  it("resolves the worker beside the distributed command module", () => {
    expect(daemonWorkerEntry("file:///C:/opt/pkg/dist/daemon-command.js"))
      .toBe(fileURLToPath("file:///C:/opt/pkg/dist/index.js"))
  })

  it("builds dependencies for the worker instead of the invoking binary", () => {
    const dependencies = nodeDaemonCommandDependencies()
    expect(dependencies.execPath).toBe(daemonWorkerEntry())
    expect(dependencies.execPath).not.toBe(process.argv[1])
    expect(dependencies.runtime).toBe(process.execPath)
  })

  it("installs a plan that runs Node with the daemon worker entry", async () => {
    const dependencies = command()
    expect(await runDaemonCommand(["install"], dependencies)).toBe(0)
    const unit = vi.mocked(dependencies.write).mock.calls.find(([path]) => path.endsWith("domovoid.service"))
    expect(unit).toBeDefined()
    expect(systemdUnitProgram(unit![1])).toEqual({
      execPath: "/usr/bin/node",
      args: ["/opt/domovoi/dist/index.js", "--service-config", "/home/dl/.domovoi/service.json"],
    })
    expect(dependencies.run).toHaveBeenCalledWith(
      "systemctl", ["--user", "enable", "--now", "domovoid.service"], expect.anything(),
    )
    expect(dependencies.stderr).not.toHaveBeenCalled()
  })

  it("returns zero for an installed but stopped service", async () => {
    const dependencies = command({ capture: vi.fn(async () => ({ code: 3, stdout: "inactive\n" })) })
    expect(await runDaemonCommand(["status"], dependencies)).toBe(0)
    expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("installed, not running:"))
  })

  it("returns one when no service is installed", async () => {
    const dependencies = command({ exists: vi.fn(async () => false) })
    expect(await runDaemonCommand(["status"], dependencies)).toBe(1)
    expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("not installed, not running:"))
  })

  it("returns one when supervision failed", async () => {
    const dependencies = command({ supervisorStatus: vi.fn(async () => ({
      installed: true, running: false, detail: "crashes exhausted", supervisionFailure: "exhausted" as const,
    })) })
    expect(await runDaemonCommand(["status"], dependencies)).toBe(1)
    expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("crashes exhausted"))
  })

  it.each([false, true])("preserves unverified registration status with failure %s", async (failed) => {
    const dependencies = command({ supervisorStatus: vi.fn(async () => ({
      installed: null, running: false, detail: "registration could not be read",
      ...(failed ? { supervisionFailure: "observation-failure" as const } : {}),
    })) })
    expect(await runDaemonCommand(["status"], dependencies)).toBe(failed ? 1 : 0)
    expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("Windows task registration unverified:"))
  })

  it("removes the service successfully", async () => {
    const dependencies = command()
    expect(await runDaemonCommand(["remove"], dependencies)).toBe(0)
    expect(dependencies.remove).toHaveBeenCalledWith(
      "/home/dl/.config/systemd/user/domovoid.service", expect.anything(),
    )
    expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("Removed the Domovoi daemon service"))
  })

  it("reports service errors on stderr with exit one", async () => {
    const dependencies = command({ run: vi.fn(async () => { throw new Error("Failed to connect to bus") }) })
    expect(await runDaemonCommand(["install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Failed to connect to bus\n")
    expect(dependencies.stdout).not.toHaveBeenCalled()
  })

  it.each([[], ["restart"], ["install", "--now"]])("prints daemon usage for invalid arguments %j", async (...args) => {
    const dependencies = command()
    expect(await runDaemonCommand(args, dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Usage: domovoi daemon install|status|remove\n")
    expect(dependencies.claimServiceOperation).not.toHaveBeenCalled()
  })
})

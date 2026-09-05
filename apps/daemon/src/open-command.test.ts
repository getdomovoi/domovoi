import { describe, expect, it, vi } from "vitest"

import { CliDeadlineError } from "./cli-rpc.js"
import { runOpenCommand, type OpenCommandDependencies } from "./open-command.js"
import type { WslDistribution } from "./wsl-distributions.js"
import { listWslDistributions } from "./wsl-list.js"

const distributions: WslDistribution[] = [
  { name: "Ubuntu-24.04", state: "Running", version: 2, default: true },
  { name: "debian", state: "Running", version: 2, default: false },
  { name: "parked", state: "Stopped", version: 2, default: false },
]

function placeInDistribution(_distribution: string, windowsPath: string): Promise<string> {
  const segments = windowsPath.replace(/\\/g, "/").split("/").filter((segment) => segment !== "")
  return Promise.resolve(`/${segments.slice(2).join("/")}`)
}

function dependencies(overrides: Partial<OpenCommandDependencies> = {}) {
  const base = {
    cwd: () => "C:\\Users\\me\\project",
    distributions: vi.fn<OpenCommandDependencies["distributions"]>(async () => distributions),
    translate: vi.fn<OpenCommandDependencies["translate"]>(placeInDistribution),
    open: vi.fn<OpenCommandDependencies["open"]>(async () => {}),
    stdout: vi.fn<OpenCommandDependencies["stdout"]>(),
    stderr: vi.fn<OpenCommandDependencies["stderr"]>(),
  }
  return Object.assign(base, overrides) as typeof base
}

describe("runOpenCommand", () => {
  it("opens the current directory when no path is given", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open"], deps)).toBe(0)
    expect(deps.open).toHaveBeenCalledWith({ kind: "windows", path: "C:\\Users\\me\\project" })
  })

  it("opens a Windows path through this machine's daemon without asking wsl.exe anything", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "C:\\work\\repo"], deps)).toBe(0)
    expect(deps.open).toHaveBeenCalledWith({ kind: "windows", path: "C:\\work\\repo" })
    expect(deps.distributions).not.toHaveBeenCalled()
    expect(deps.translate).not.toHaveBeenCalled()
  })

  it("opens a Windows path without waiting on a wsl.exe that never answers", async () => {
    const deps = dependencies({
      distributions: vi.fn(() => new Promise<WslDistribution[]>(() => {})),
      translate: vi.fn(() => new Promise<string>(() => {})),
    })
    expect(await runOpenCommand(["open", "C:\\work\\repo"], deps)).toBe(0)
    expect(deps.open).toHaveBeenCalledWith({ kind: "windows", path: "C:\\work\\repo" })
  })

  it("does not call a wsl.exe it may not run a missing distribution", async () => {
    const deps = dependencies({
      distributions: vi.fn(() => listWslDistributions({
        platform: "win32",
        run: async () => {
          throw Object.assign(new Error("spawn wsl.exe EACCES"), { code: "EACCES" })
        },
      })),
    })
    expect(await runOpenCommand(["open", "\\\\wsl$\\Ubuntu-24.04\\home\\me"], deps)).toBe(1)
    const stderr = deps.stderr.mock.calls.join("")
    expect(stderr).not.toMatch(/no WSL distribution called/)
    expect(stderr).toMatch(/denied/i)
    expect(deps.open).not.toHaveBeenCalled()
  })

  it("opens a directory inside a distribution through that distribution, at the path it answered", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\wsl$\\debian\\srv\\app"], deps)).toBe(0)
    expect(deps.translate).toHaveBeenCalledWith("debian", "\\\\wsl$\\debian\\srv\\app")
    expect(deps.open).toHaveBeenCalledWith({ kind: "wsl", distribution: "debian", path: "/srv/app" })
  })

  it("reads . as the directory the command was run in", async () => {
    const deps = dependencies({ cwd: () => "\\\\wsl$\\Ubuntu-24.04\\home\\me\\work" })
    expect(await runOpenCommand(["open", "."], deps)).toBe(0)
    expect(deps.open).toHaveBeenCalledWith({
      kind: "wsl",
      distribution: "Ubuntu-24.04",
      path: "/home/me/work",
    })
  })

  it("reads the wsl.localhost form the same way", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\wsl.localhost\\debian\\srv\\app"], deps)).toBe(0)
    expect(deps.open).toHaveBeenCalledWith({ kind: "wsl", distribution: "debian", path: "/srv/app" })
  })

  it("says which distribution the work was opened in", async () => {
    const deps = dependencies()
    await runOpenCommand(["open", "\\\\wsl$\\debian\\srv\\app"], deps)
    expect(deps.stdout.mock.calls.join("")).toContain("debian")
  })

  it("refuses a distribution this machine does not have, and opens nothing", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\wsl$\\arch\\home"], deps)).toBe(1)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.stderr.mock.calls.join("")).toContain("arch")
  })

  it("refuses a stopped distribution with the way to start it, and opens nothing", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\wsl$\\parked\\home"], deps)).toBe(1)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.translate).not.toHaveBeenCalled()
    expect(deps.stderr.mock.calls.join("")).toMatch(/parked is stopped.*wsl\.exe -d parked/s)
  })

  it("refuses a Windows drive reached through the share, in the distribution's words", async () => {
    const deps = dependencies({
      translate: vi.fn(async () => {
        throw new Error("\\\\wsl$\\debian\\mnt\\c\\repo is on a Windows drive that debian mounts. Open C:\\repo from Windows instead.")
      }),
    })
    expect(await runOpenCommand(["open", "\\\\wsl$\\debian\\mnt\\c\\repo"], deps)).toBe(1)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.stderr.mock.calls.join("")).toMatch(/Windows drive.*C:\\repo/s)
  })

  it("refuses a network share, and opens nothing", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\fileserver\\share"], deps)).toBe(1)
    expect(deps.open).not.toHaveBeenCalled()
  })

  it("reports a failure to open without pretending it worked", async () => {
    const deps = dependencies({ open: vi.fn(async () => { throw new Error("no daemon there") }) })
    expect(await runOpenCommand(["open", "."], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toContain("open")
  })

  it("repeats a refusal that names the distribution and its remedy", async () => {
    const deps = dependencies({
      open: vi.fn(async () => {
        throw new Error("no daemon is running in debian. Run domovoid inside debian and try again.")
      }),
    })
    expect(await runOpenCommand(["open", "\\\\wsl$\\debian\\srv\\app"], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toMatch(/no daemon is running in debian.*domovoid/s)
  })

  it("repeats a deadline refusal that names the address and the remedy", async () => {
    const deps = dependencies({
      open: vi.fn(async () => {
        throw new CliDeadlineError("The daemon at ws://127.0.0.1:47831/rpc did not accept the connection"
          + " before the deadline. Check that domovoid is running at that address, then run this command again.")
      }),
    })
    expect(await runOpenCommand(["open", "C:\\work\\repo"], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toContain("did not accept the connection before the deadline")
    expect(deps.stderr.mock.calls.join("")).toContain("Check that domovoid is running at that address")
  })

  it("prints usage for more arguments than it takes", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", ".", "extra"], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toContain("Usage: domovoid open")
    expect(deps.open).not.toHaveBeenCalled()
  })

  it("leaves another command alone", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["pair"], deps)).toBe(1)
    expect(deps.open).not.toHaveBeenCalled()
  })
})

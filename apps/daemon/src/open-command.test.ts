import { describe, expect, it, vi } from "vitest"

import { runOpenCommand, type OpenCommandDependencies } from "./open-command.js"

const distributions = [{ name: "Ubuntu-24.04" }, { name: "debian" }]

function dependencies(overrides: Partial<OpenCommandDependencies> = {}) {
  const base = {
    cwd: () => "C:\\Users\\me\\project",
    distributions: async () => distributions,
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

  it("opens a directory inside a distribution through that distribution", async () => {
    const deps = dependencies()
    expect(await runOpenCommand(["open", "\\\\wsl$\\debian\\srv\\app"], deps)).toBe(0)
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

import { describe, expect, it, vi } from "vitest"

import { runWslCommand, type WslCommandDependencies } from "./wsl-command.js"
import type { WslMachineFact } from "./wsl-discovery.js"

const discovered: WslMachineFact[] = [
  {
    distribution: "Ubuntu-24.04", version: 2, state: "running", default: true,
    daemon: "present", endpoint: "ws://127.0.0.1:47832/rpc",
  },
  { distribution: "parked", version: 2, state: "stopped", default: false, daemon: "absent" },
  { distribution: "Legacy", version: 1, state: "running", default: false, daemon: "unknown" },
]

function dependencies(overrides: Partial<WslCommandDependencies> = {}) {
  const base = {
    platform: "win32" as const,
    discover: vi.fn<WslCommandDependencies["discover"]>(async () => discovered),
    stdout: vi.fn<WslCommandDependencies["stdout"]>(),
    stderr: vi.fn<WslCommandDependencies["stderr"]>(),
  }
  return Object.assign(base, overrides) as typeof base
}

describe("runWslCommand", () => {
  it("lists every distribution with its version, state, and daemon", async () => {
    const deps = dependencies()
    expect(await runWslCommand(["wsl", "list"], deps)).toBe(0)
    const output = deps.stdout.mock.calls.join("")
    const lines = output.trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/Ubuntu-24\.04.*WSL 2.*running.*daemon at ws:\/\/127\.0\.0\.1:47832\/rpc.*default/)
    expect(lines[1]).toMatch(/parked.*WSL 2.*stopped.*no daemon/)
    expect(lines[2]).toMatch(/Legacy.*WSL 1.*running.*could not be asked/)
  })

  it("says when no distribution is installed", async () => {
    const deps = dependencies({ discover: vi.fn(async () => []) })
    expect(await runWslCommand(["wsl", "list"], deps)).toBe(0)
    expect(deps.stdout.mock.calls.join("")).toMatch(/No WSL distribution/)
  })

  it("refuses off Windows, where there is no wsl.exe to ask", async () => {
    const deps = dependencies({ platform: "linux" })
    expect(await runWslCommand(["wsl", "list"], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toMatch(/Windows/)
    expect(deps.discover).not.toHaveBeenCalled()
  })

  it("reports a discovery that failed without a stack trace", async () => {
    const deps = dependencies({
      discover: vi.fn(async () => {
        throw new Error("spawn wsl.exe ENOENT")
      }),
    })
    expect(await runWslCommand(["wsl", "list"], deps)).toBe(1)
    expect(deps.stderr.mock.calls.join("")).toMatch(/wsl\.exe/)
    expect(deps.stderr.mock.calls.join("")).not.toMatch(/at .*\.ts:\d+/)
  })

  it("prints usage for a subcommand it does not have, or arguments it does not take", async () => {
    for (const args of [["wsl"], ["wsl", "frobnicate"], ["wsl", "list", "extra"]]) {
      const deps = dependencies()
      expect(await runWslCommand(args, deps)).toBe(1)
      expect(deps.stderr.mock.calls.join("")).toContain("Usage: domovoid wsl list")
      expect(deps.discover).not.toHaveBeenCalled()
    }
  })

  it("leaves another command alone", async () => {
    const deps = dependencies()
    expect(await runWslCommand(["pair"], deps)).toBe(1)
    expect(deps.discover).not.toHaveBeenCalled()
    expect(deps.stderr).not.toHaveBeenCalled()
  })
})

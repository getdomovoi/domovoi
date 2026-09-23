import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  claudeInstallProblem,
  claudeMinimumVersion,
  resolveClaudeSdkExecutable,
} from "./claude-install.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function pathWith(...names: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-claude-install-"))
  directories.push(directory)
  for (const name of names) {
    await writeFile(join(directory, name), "")
    await chmod(join(directory, name), 0o755)
  }
  return directory
}

describe("resolveClaudeSdkExecutable on Windows", () => {
  it("takes the native claude.exe even when a shim comes first on PATH", async () => {
    const shims = await pathWith("claude", "claude.cmd")
    const native = await pathWith("claude.exe")

    expect(resolveClaudeSdkExecutable(`${shims};${native}`, "win32"))
      .toEqual({ executable: join(native, "claude.exe") })
  })

  it.each(["claude", "claude.cmd"])("refuses the %s shim and names it", async (shim) => {
    const directory = await pathWith(shim)

    const resolved = resolveClaudeSdkExecutable(directory, "win32")

    expect(resolved).toEqual({ problem: expect.stringContaining(join(directory, shim)) })
    expect("problem" in resolved && resolved.problem).toMatch(/native claude\.exe/)
  })
})

describe("resolveClaudeSdkExecutable elsewhere", () => {
  it.runIf(process.platform !== "win32")("takes claude from PATH and says when there is none", async () => {
    const directory = await pathWith("claude")

    expect(resolveClaudeSdkExecutable(directory, "darwin")).toEqual({ executable: join(directory, "claude") })
    expect(resolveClaudeSdkExecutable(await pathWith(), "linux"))
      .toEqual({ problem: "Claude Code is not installed: no claude executable was found on the tool PATH" })
  })
})

describe("claudeInstallProblem", () => {
  it("asks for the Claude Code version the SDK was built against, or newer", () => {
    expect(claudeMinimumVersion).toBe("2.1.263")
    expect(claudeInstallProblem({ command: "claude", version: "2.1.100", platform: "darwin" }))
      .toBe("Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100.")
    for (const version of ["2.1.263", "2.1.280", "2.2.0", "3.0.0", undefined]) {
      expect(claudeInstallProblem({ command: "claude", version, platform: "darwin" }), String(version)).toBeUndefined()
    }
  })

  it("names a Windows shim the SDK cannot start", () => {
    expect(claudeInstallProblem({ command: "C:\\npm\\claude.cmd", version: "2.1.280", platform: "win32" }))
      .toMatch(/C:\\npm\\claude\.cmd .*native claude\.exe/)
    expect(claudeInstallProblem({ command: "C:\\Claude\\claude.exe", version: "2.1.280", platform: "win32" })).toBeUndefined()
  })
})

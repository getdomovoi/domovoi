import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  claudeInstallProblem,
  claudeMinimumVersion,
  installedClaudeVersion,
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

  // A probe with no PATH runs the bare name, and Windows starts claude.exe for
  // it. Only a resolved script (.cmd, .bat, .ps1, or a path with no extension)
  // is a shim.
  it("does not call a bare claude a shim on Windows", () => {
    expect(claudeInstallProblem({ command: "claude", version: "2.1.280", platform: "win32" })).toBeUndefined()
    expect(claudeInstallProblem({ command: "C:\\npm\\claude", version: "2.1.280", platform: "win32" })).toMatch(/script shim/)
  })

  it("names a Windows shim the SDK cannot start", () => {
    expect(claudeInstallProblem({ command: "C:\\npm\\claude.cmd", version: "2.1.280", platform: "win32" }))
      .toMatch(/C:\\npm\\claude\.cmd .*native claude\.exe/)
    expect(claudeInstallProblem({ command: "C:\\Claude\\claude.exe", version: "2.1.280", platform: "win32" })).toBeUndefined()
  })
})

describe("the minimum Claude Code version", () => {
  // The floor is the Claude Code the installed SDK was built against. A bump of
  // the SDK must move it too, so the constant is checked against the SDK's own
  // package.json rather than against itself.
  it("is the claudeCodeVersion the installed SDK names", async () => {
    const require = createRequire(import.meta.url)
    let directory = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"))
    while (!(await readFile(join(directory, "package.json"), "utf8").then(() => true, () => false))) directory = dirname(directory)
    const sdk = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name: string; claudeCodeVersion?: string }

    expect(sdk.name).toBe("@anthropic-ai/claude-agent-sdk")
    expect(claudeMinimumVersion).toBe(sdk.claudeCodeVersion)
  })
})

describe("reading the installed claude's version", () => {
  // The check runs on the daemon's event loop. A claude slow to answer
  // --version must not stop every client, terminal and approval meanwhile.
  it.runIf(process.platform !== "win32")("does not block the event loop while claude answers --version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-claude-slow-"))
    directories.push(directory)
    const executable = join(directory, "claude")
    await writeFile(executable, "#!/bin/sh\nsleep 1\necho '2.1.300 (Claude Code)'\n")
    await chmod(executable, 0o755)

    // A timer due now fires late by however long the loop was held.
    const started = Date.now()
    const timerDelay = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 0))
    const version = Promise.resolve().then(() => installedClaudeVersion(executable))

    expect(await timerDelay).toBeLessThan(500)
    await expect(version).resolves.toBe("2.1.300")
  })

  // A claude the OS refuses to start fails inside spawn itself: ENOEXEC here,
  // UNKNOWN for a claude.exe that is not a Windows program. The version is then
  // unknown; the check must not throw.
  it("reports an unknown version when the OS cannot start claude", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-claude-unstartable-"))
    directories.push(directory)
    const executable = join(directory, process.platform === "win32" ? "claude.exe" : "claude")
    await writeFile(executable, "not a program\n")
    await chmod(executable, 0o755)

    await expect(installedClaudeVersion(executable)).resolves.toBeUndefined()
  })
})

import { execFile } from "node:child_process"
import { statSync } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { join, win32 } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { runningInCi } from "../vitest.global-setup.js"
import { createDaemonTestHome, daemonTestEnvironment, daemonTestHomePrefix, daemonTestLoginProfile, inheritedPath } from "../vitest.setup.js"
import { loginShellPathCommand } from "./tool-path.js"

const execute = promisify(execFile)

describe("native profile guard CI detection", () => {
  it.each([
    ["true", true],
    ["1", true],
    [undefined, false],
    ["", false],
    ["false", false],
    ["FALSE", false],
    ["0", false],
  ])("treats CI=%s as %s", (flag, expected) => {
    expect(runningInCi(flag === undefined ? {} : { CI: flag })).toBe(expected)
  })
})

describe("daemon test scratch home creation", () => {
  it("uses the short Windows sibling when its parent is writable", () => {
    const mkdtemp = vi.fn((prefix: string) => `${prefix}ABCDEF`)
    expect(createDaemonTestHome("win32", "D:\\Temp", mkdtemp)).toBe("D:\\dv-ABCDEF")
    expect(mkdtemp).toHaveBeenCalledExactlyOnceWith("D:\\dv-")
  })

  it.each(["EACCES", "EPERM"])("falls back inside Windows TEMP after %s from its parent", (code) => {
    const mkdtemp = vi.fn((prefix: string) => `${prefix}ABCDEF`)
      .mockImplementationOnce(() => { throw Object.assign(new Error("parent is not writable"), { code }) })
    const home = createDaemonTestHome("win32", "D:\\Temp", mkdtemp)
    expect(home).toBe("D:\\Temp\\dv-ABCDEF")
    expect(mkdtemp.mock.calls).toEqual([["D:\\dv-"], ["D:\\Temp\\dv-"]])
    expect(daemonTestEnvironment("win32", home)).toEqual({ HOME: home, USERPROFILE: home, TEMP: home, TMP: home })
  })

  it("rethrows other Windows creation errors without a fallback", () => {
    const error = Object.assign(new Error("disk is full"), { code: "ENOSPC" })
    const mkdtemp = vi.fn(() => { throw error })
    expect(() => createDaemonTestHome("win32", "D:\\Temp", mkdtemp)).toThrow(error)
    expect(mkdtemp).toHaveBeenCalledExactlyOnceWith("D:\\dv-")
  })

  it.each(["darwin", "linux"] as const)("keeps creation inside the temporary directory on %s", (platform) => {
    const prefix = join(tmpdir(), "domovoi-vitest-home-")
    const mkdtemp = vi.fn((prefix: string) => `${prefix}ABCDEF`)
    expect(createDaemonTestHome(platform, tmpdir(), mkdtemp)).toBe(`${prefix}ABCDEF`)
    expect(mkdtemp).toHaveBeenCalledExactlyOnceWith(prefix)
  })

  it.each(["darwin", "linux"] as const)("does not retry a permission error on %s", (platform) => {
    const error = Object.assign(new Error("temp is not writable"), { code: "EACCES" })
    const mkdtemp = vi.fn(() => { throw error })
    expect(() => createDaemonTestHome(platform, tmpdir(), mkdtemp)).toThrow(error)
    expect(mkdtemp).toHaveBeenCalledExactlyOnceWith(join(tmpdir(), "domovoi-vitest-home-"))
  })
})

describe("daemon test scratch environment", () => {
  it.skipIf(process.platform === "win32")("preserves the inherited PATH in the scratch home's login shell", async () => {
    const shell = process.env.SHELL ?? userInfo().shell
    if (!shell) throw new Error("The login PATH regression requires the account shell")
    const [command, args] = loginShellPathCommand(shell)
    const { stdout } = await execute(command, args, { env: { ...process.env, HOME: homedir() }, timeout: 5_000 })
    expect(stdout.startsWith(inheritedPath)).toBe(true)
  })

  it.skipIf(process.platform === "win32")("preserves literal shell characters in the inherited PATH", async () => {
    const path = "/runner/it's $HOME `printf changed` $(printf changed) \\ tools:/usr/bin"
    const { stdout } = await execute("/bin/sh", ["-c", `${daemonTestLoginProfile(path)}printf '%s' "$PATH"`], { timeout: 5_000 })
    expect(stdout).toBe(path)
  })

  it("keeps Windows temporary files inside the scratch user profile", () => {
    const home = "C:\\Users\\runneradmin\\AppData\\Local\\dv-ABCDEF"
    const environment = daemonTestEnvironment("win32", home)
    expect(environment).toEqual({
      HOME: home, USERPROFILE: home,
      TEMP: home, TMP: home,
    })
  })

  const runnerTemp = "C:\\Users\\runneradmin\\AppData\\Local\\Temp"
  const uuid = "00000000-0000-0000-0000-000000000000"
  // Match the large-status fixture and the incoming checkpoint ref lock that
  // Git fetch creates for both production fleet transfer fixtures.
  it.each([
    ["large-status file", ["domovoi-large-ABCDEF", "project", `untracked-00000-${"x".repeat(144)}`]],
    ["fleet checkpoint lock", ["domovoi-fleet-production-ABCDEF", "target", ".git", "refs", "domovoi",
      "incoming", `session-${uuid}`, uuid, "checkpoints", `${"a".repeat(40)}.lock`]],
  ])("keeps the Windows %s path below Git's traditional path limit", (_name, segments) => {
    const home = `${daemonTestHomePrefix("win32", runnerTemp)}ABCDEF`
    const environment = daemonTestEnvironment("win32", home)
    expect(win32.join(environment.TEMP!, ...segments).length).toBeLessThan(260)
  })

  it("adds at most five characters to the Windows runner temp path", () => {
    const home = `${daemonTestHomePrefix("win32", runnerTemp)}ABCDEF`
    expect(win32.dirname(home)).toBe(win32.dirname(runnerTemp))
    expect(home.length).toBeLessThanOrEqual(runnerTemp.length + 5)
  })

  it.each(["darwin", "linux"] as const)("preserves inherited temp settings on %s", (platform) => {
    expect(daemonTestEnvironment(platform, "/scratch/home")).toEqual({
      HOME: "/scratch/home", USERPROFILE: "/scratch/home",
    })
  })

  it.skipIf(process.platform !== "win32")("creates the active Windows temporary directory under the scratch profile", () => {
    expect(process.env.USERPROFILE).toBe(homedir())
    expect(tmpdir()).toBe(homedir())
    expect(process.env.TEMP).toBe(tmpdir())
    expect(process.env.TMP).toBe(tmpdir())
    expect(statSync(tmpdir()).isDirectory()).toBe(true)
  })
})

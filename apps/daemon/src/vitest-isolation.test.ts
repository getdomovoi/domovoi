import { execFile } from "node:child_process"
import { statSync } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { win32 } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { runningInCi } from "../vitest.global-setup.js"
import { daemonTestEnvironment, daemonTestHomePrefix, daemonTestLoginProfile, inheritedPath } from "../vitest.setup.js"
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

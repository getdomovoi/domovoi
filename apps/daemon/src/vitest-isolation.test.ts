import { statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { win32 } from "node:path"
import { describe, expect, it } from "vitest"
import { runningInCi } from "../vitest.global-setup.js"
import { daemonTestEnvironment } from "../vitest.setup.js"

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
  it("keeps Windows temporary files inside the scratch user profile", () => {
    const home = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\domovoi-vitest-home-fixture"
    const environment = daemonTestEnvironment("win32", home)
    expect(environment).toEqual({
      HOME: home, USERPROFILE: home,
      TEMP: win32.join(home, "tmp"), TMP: win32.join(home, "tmp"),
    })
  })

  it.each(["darwin", "linux"] as const)("preserves inherited temp settings on %s", (platform) => {
    expect(daemonTestEnvironment(platform, "/scratch/home")).toEqual({
      HOME: "/scratch/home", USERPROFILE: "/scratch/home",
    })
  })

  it.skipIf(process.platform !== "win32")("creates the active Windows temporary directory under the scratch profile", () => {
    expect(process.env.USERPROFILE).toBe(homedir())
    expect(tmpdir()).toBe(win32.join(homedir(), "tmp"))
    expect(process.env.TEMP).toBe(tmpdir())
    expect(process.env.TMP).toBe(tmpdir())
    expect(statSync(tmpdir()).isDirectory()).toBe(true)
  })
})

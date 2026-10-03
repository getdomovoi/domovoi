import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { configureLaunchSmokeProfile } from "./launch-smoke-profile.js"

const roots: string[] = []
// One removal that throws must not abandon the rest, and no root leaves this
// list before it is gone, so a later hook still has something to remove.
afterEach(() => {
  const failures: unknown[] = []
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    try {
      rmSync(roots[index]!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      roots.splice(index, 1)
    } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Scratch removal failed")
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "domovoi-smoke-profile-"))
  roots.push(root)
  mkdirSync(join(root, "config"))
  mkdirSync(join(root, "data"))
  return root
}

describe("launch smoke profile", () => {
  it("sets Electron data paths explicitly instead of relying on HOME support", () => {
    const profile = fixture()
    const setPath = vi.fn()
    configureLaunchSmokeProfile({ setPath }, profile, profile)
    expect(setPath.mock.calls).toEqual([
      ["userData", join(profile, "config")], ["sessionData", join(profile, "data")], ["logs", join(profile, "data")],
    ])
  })

  it("refuses a missing or different home without changing Electron paths", () => {
    const profile = fixture()
    const setPath = vi.fn()
    for (const reported of [undefined, join(profile, "other")]) {
      expect(() => configureLaunchSmokeProfile({ setPath }, reported, profile)).toThrow("own empty profile")
    }
    expect(setPath).not.toHaveBeenCalled()
  })

  it("refuses to reuse a daemon profile without changing Electron paths", () => {
    const profile = fixture()
    mkdirSync(join(profile, ".domovoi"))
    const setPath = vi.fn()
    expect(() => configureLaunchSmokeProfile({ setPath }, profile, profile)).toThrow("own empty profile")
    expect(setPath).not.toHaveBeenCalled()
  })
})

// index.ts reads userData once, as userDataDirectory, and every later use
// takes that value. It can only go stale if userData is set after the read,
// so the main process sets it in one place, the smoke profile above, and
// index.ts calls that before the read. --user-data-dir is Electron's own
// switch and is applied before the main script runs.
describe("the userData read in the main process", () => {
  const main = import.meta.dirname

  it("happens once, after the only place that sets userData", () => {
    const index = readFileSync(join(main, "index.ts"), "utf8")
    expect(index.match(/getPath\("userData"\)/gu)).toHaveLength(1)
    const read = index.indexOf('const userDataDirectory = app.getPath("userData")')
    const configured = index.indexOf("configureLaunchSmokeProfile(app,")
    expect(read).toBeGreaterThan(-1)
    expect(configured).toBeGreaterThan(-1)
    expect(configured).toBeLessThan(read)
    expect(index).not.toMatch(/\bsetPath\(|\bsetName\(/u)
  })

  it("has no other writer in the main process sources", () => {
    const writers = readdirSync(main)
      .filter((name) => /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name))
      .filter((name) => /setPath\(\s*"userData"|\bsetName\(/u.test(readFileSync(join(main, name), "utf8")))
    expect(writers).toEqual(["launch-smoke-profile.ts"])
  })
})

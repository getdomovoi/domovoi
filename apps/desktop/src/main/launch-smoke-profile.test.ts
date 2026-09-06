import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { configureLaunchSmokeProfile } from "./launch-smoke-profile.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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

import assert from "node:assert/strict"
import test from "node:test"

import { launchSmokeElectronArgs, launchSmokeTimeoutMs } from "./launch-smoke-args.mjs"

test("disables the Chromium sandbox only on Linux CI", () => {
  assert.deepEqual(
    launchSmokeElectronArgs({ platform: "linux", ci: true, desktopRoot: "/desktop" }),
    ["--no-sandbox", "--headless", "--disable-gpu", "/desktop"],
  )
})

test("keeps the Chromium sandbox outside Linux CI", () => {
  for (const [platform, ci] of [
    ["linux", false],
    ["darwin", true],
    ["win32", true],
  ]) {
    assert.deepEqual(
      launchSmokeElectronArgs({ platform, ci, desktopRoot: "/desktop" }),
      ["--headless", "--disable-gpu", "/desktop"],
    )
  }
})

test("gives Windows a longer launch budget, where Electron starts slowest on CI", () => {
  assert.equal(launchSmokeTimeoutMs({ platform: "win32", env: {} }), 60_000)
  assert.equal(launchSmokeTimeoutMs({ platform: "linux", env: {} }), 15_000)
  assert.equal(launchSmokeTimeoutMs({ platform: "darwin", env: {} }), 15_000)
})

test("lets the budget be set explicitly", () => {
  assert.equal(
    launchSmokeTimeoutMs({ platform: "linux", env: { DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS: "5000" } }),
    5_000,
  )
})

test("ignores a budget that is not a positive number", () => {
  for (const value of ["", "0", "-1", "soon"]) {
    assert.equal(
      launchSmokeTimeoutMs({ platform: "linux", env: { DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS: value } }),
      15_000,
    )
  }
})

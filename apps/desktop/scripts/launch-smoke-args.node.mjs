import assert from "node:assert/strict"
import test from "node:test"

import { launchSmokeElectronArgs } from "./launch-smoke-args.mjs"

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

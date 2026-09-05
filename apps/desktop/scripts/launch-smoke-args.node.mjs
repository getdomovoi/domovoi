import assert from "node:assert/strict"
import test from "node:test"

import { launchSmokeElectronArgs, launchSmokeEnvironment, launchSmokeTimeoutMs } from "./launch-smoke-args.mjs"

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
  assert.equal(launchSmokeTimeoutMs({ platform: "win32", env: {} }), 90_000)
  assert.equal(launchSmokeTimeoutMs({ platform: "linux", env: {} }), 60_000)
  assert.equal(launchSmokeTimeoutMs({ platform: "darwin", env: {} }), 60_000)
})

test("lets the budget be set explicitly", () => {
  assert.equal(
    launchSmokeTimeoutMs({ platform: "linux", env: { DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS: "5000" } }),
    5_000,
  )
})

test("ignores a budget that is not a positive number", () => {
  for (const value of ["", "0", "-1", "soon", "0.5", "2147483648"]) {
    assert.equal(
      launchSmokeTimeoutMs({ platform: "linux", env: { DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS: value } }),
      60_000,
    )
  }
})

test("isolates production paths and listener settings from the parent environment", () => {
  const env = launchSmokeEnvironment({
    profileRoot: "/smoke", timeoutMs: 60_000,
    env: {
      PATH: "/bin", DISPLAY: ":1", USERPROFILE: "/real-user", HOME: "/real-user",
      DOMOVOI_AUTH_TOKEN: "real-token", DOMOVOI_CREDENTIAL_PATH: "/real-token-file",
      domovoi_machine_identity_path: "/real-machine", DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_TLS_KEY_PATH: "/real-key", DOMOVOI_TAILNET_HOST: "real-peer",
      ELECTRON_RENDERER_URL: "https://untrusted.invalid", ELECTRON_RUN_AS_NODE: "1",
    },
  })
  assert.equal(env.PATH, "/bin")
  assert.equal(env.DISPLAY, ":1")
  assert.equal(env.HOME, "/smoke")
  assert.equal(env.USERPROFILE, "/smoke")
  assert.equal(env.DOMOVOI_HOST, "127.0.0.1")
  assert.equal(env.DOMOVOI_PORT, "0")
  assert.equal(env.DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS, "60000")
  for (const key of ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "domovoi_machine_identity_path",
    "DOMOVOI_TLS_KEY_PATH", "DOMOVOI_TAILNET_HOST", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE"]) {
    assert.equal(env[key], undefined, key)
  }
})

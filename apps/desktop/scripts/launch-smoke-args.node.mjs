import assert from "node:assert/strict"
import test from "node:test"

import {
  launchSmokeElectronArgs,
  launchSmokeEnvironment,
  launchSmokeTimeoutMs,
  packagedAppCandidates,
  packagedAsarPath,
} from "./launch-smoke-args.mjs"

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

test("omits the application directory for a packaged build, which carries its own", () => {
  assert.deepEqual(
    launchSmokeElectronArgs({ platform: "linux", ci: true, desktopRoot: "/desktop", packaged: true }),
    ["--no-sandbox", "--headless", "--disable-gpu"],
  )
})

test("names every directory electron-builder writes an unpacked application to", () => {
  const options = { distDirectory: "/dist", productName: "Domovoi", executableName: "domovoi-desktop" }
  assert.deepEqual(packagedAppCandidates({ platform: "linux", ...options }), [
    "/dist/linux-unpacked/domovoi-desktop",
    "/dist/linux-arm64-unpacked/domovoi-desktop",
  ])
  assert.deepEqual(packagedAppCandidates({ platform: "win32", ...options }), [
    "/dist/win-unpacked/Domovoi.exe",
    "/dist/win-arm64-unpacked/Domovoi.exe",
  ])
  assert.deepEqual(packagedAppCandidates({ platform: "darwin", ...options }), [
    "/dist/mac/Domovoi.app/Contents/MacOS/Domovoi",
    "/dist/mac-arm64/Domovoi.app/Contents/MacOS/Domovoi",
    "/dist/mac-universal/Domovoi.app/Contents/MacOS/Domovoi",
  ])
})

test("finds the archive beside the packaged executable on every platform", () => {
  assert.equal(
    packagedAsarPath({ platform: "linux", executablePath: "/dist/linux-unpacked/domovoi-desktop" }),
    "/dist/linux-unpacked/resources/app.asar",
  )
  assert.equal(
    packagedAsarPath({ platform: "win32", executablePath: "/dist/win-unpacked/Domovoi.exe" }),
    "/dist/win-unpacked/resources/app.asar",
  )
  assert.equal(
    packagedAsarPath({ platform: "darwin", executablePath: "/dist/mac/Domovoi.app/Contents/MacOS/Domovoi" }),
    "/dist/mac/Domovoi.app/Contents/Resources/app.asar",
  )
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
      home: "/case-variant-user", userprofile: "/case-variant-user", appdata: "/case-variant-data",
      DOMOVOI_AUTH_TOKEN: "real-token", DOMOVOI_CREDENTIAL_PATH: "/real-token-file",
      domovoi_machine_identity_path: "/real-machine", DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_TLS_KEY_PATH: "/real-key", DOMOVOI_TAILNET_HOST: "real-peer",
      ELECTRON_RENDERER_URL: "https://untrusted.invalid", ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require=/real-startup.cjs",
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
    "DOMOVOI_TLS_KEY_PATH", "DOMOVOI_TAILNET_HOST", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS", "home", "userprofile", "appdata"]) {
    assert.equal(env[key], undefined, key)
  }
})

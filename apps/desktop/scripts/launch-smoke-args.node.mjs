import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { sep } from "node:path"
import test from "node:test"

import {
  launchSmokeElectronArgs,
  launchSmokeEnvironment,
  launchSmokeTimeoutMs,
  packagedAppCandidates,
  packagedAsarPath,
} from "./launch-smoke-args.mjs"
import * as launch from "./launch-smoke-args.mjs"
import { executableOnPath } from "./desktop-smoke.mjs"

// Both path builders name a target platform's output directories, but the
// paths themselves are opened and spawned on the machine doing the packaging,
// so the separator belongs to that host and never to the target. Comparing
// against a posix literal fails on Windows for a reason that says nothing
// about packaging. What the two functions owe their caller is the directory
// and file names, in order, in a path the host can open, so the comparison is
// made separator agnostic and the host separator is asserted on its own.
const foreignSeparator = sep === "\\" ? "/" : "\\"

function hostPath(value) {
  assert.ok(!value.includes(foreignSeparator), `${value} does not use the ${JSON.stringify(sep)} separator of its host`)
  return value.split(sep).join("/")
}

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

test("wraps Linux Electron in the discovered X server without shell interpolation", () => {
  const electronArgs = launchSmokeElectronArgs({ platform: "linux", ci: true, desktopRoot: "/proof with spaces" })
  assert.deepEqual(launch.launchSmokeCommand({ platform: "linux", env: {}, electronPath: "/Electron path/electron", electronArgs, xvfb: "/tools/xvfb-run" }), {
    command: "/tools/xvfb-run", args: ["--auto-servernum", "/Electron path/electron", ...electronArgs],
  })
})

test("uses a local X or Wayland display when xvfb-run is absent", () => {
  for (const env of [{ DISPLAY: ":1" }, { WAYLAND_DISPLAY: "wayland-0" }]) {
    const electronArgs = launchSmokeElectronArgs({ platform: "linux", ci: false, desktopRoot: "/proof" })
    assert.deepEqual(launch.launchSmokeCommand({ platform: "linux", env, electronPath: "/electron", electronArgs }), {
      command: "/electron", args: electronArgs,
    })
  }
})

test("names the missing Linux display prerequisite instead of starting a doomed proof", () => {
  assert.throws(() => launch.launchSmokeCommand({ platform: "linux", env: {}, electronPath: "/electron", electronArgs: [] }),
    /Install xvfb-run.*DISPLAY.*WAYLAND_DISPLAY/u)
})

test("never adds an X server or Linux-only flag on Windows and macOS", () => {
  for (const platform of ["win32", "darwin"]) {
    const electronArgs = launchSmokeElectronArgs({ platform, ci: true, desktopRoot: "/proof" })
    const result = launch.launchSmokeCommand({ platform, env: {}, electronPath: "/electron", electronArgs, xvfb: "/tools/xvfb-run" })
    assert.deepEqual(result, { command: "/electron", args: ["--headless", "--disable-gpu", "/proof"] })
  }
})

for (const name of ["fleet-origin-smoke.mjs", "fleet-client-smoke.mjs"]) {
  test(`${name} uses the shared launch and environment policies`, async () => {
    const source = await readFile(new URL(name, import.meta.url), "utf8")
    for (const helper of ["launchSmokeElectronArgs", "launchSmokeCommand", "launchSmokeEnvironment"]) {
      assert.match(source, new RegExp(`${helper}\\(`, "u"), `${name} bypasses ${helper}`)
    }
    assert.match(source, /executableOnPath\("xvfb-run"\)/u)
    assert.doesNotMatch(source, /["']--no-sandbox["']|ELECTRON_RUN_AS_NODE\s*:/u)
  })
}

test("display executable discovery cannot hang the proof before its child starts", { timeout: 1_000 }, async () => {
  await assert.rejects(executableOnPath("xvfb-run", {
    env: { PATH: "/silent" }, timeoutMs: 20, checkAccess: () => new Promise(() => {}),
  }), /Timed out finding xvfb-run/u)
})

test("omits the application directory for a packaged build, which carries its own", () => {
  assert.deepEqual(
    launchSmokeElectronArgs({ platform: "linux", ci: true, desktopRoot: "/desktop", packaged: true }),
    ["--no-sandbox", "--headless", "--disable-gpu"],
  )
})

const packagedOptions = { distDirectory: "/dist", productName: "Domovoi", executableName: "domovoi-desktop" }

test("names every directory electron-builder writes an unpacked application to", () => {
  assert.deepEqual(packagedAppCandidates({ platform: "linux", ...packagedOptions }).map(hostPath), [
    "/dist/linux-unpacked/domovoi-desktop",
    "/dist/linux-arm64-unpacked/domovoi-desktop",
  ])
  assert.deepEqual(packagedAppCandidates({ platform: "win32", ...packagedOptions }).map(hostPath), [
    "/dist/win-unpacked/Domovoi.exe",
    "/dist/win-arm64-unpacked/Domovoi.exe",
  ])
  assert.deepEqual(packagedAppCandidates({ platform: "darwin", ...packagedOptions }).map(hostPath), [
    "/dist/mac/Domovoi.app/Contents/MacOS/Domovoi",
    "/dist/mac-arm64/Domovoi.app/Contents/MacOS/Domovoi",
    "/dist/mac-universal/Domovoi.app/Contents/MacOS/Domovoi",
  ])
})

test("finds the archive beside the packaged executable on every platform", () => {
  // Fed from the candidate rather than from a literal, which is how the
  // package smoke reaches the archive and keeps the two in step.
  for (const [platform, archive] of [
    ["linux", "/dist/linux-unpacked/resources/app.asar"],
    ["win32", "/dist/win-unpacked/resources/app.asar"],
    ["darwin", "/dist/mac/Domovoi.app/Contents/Resources/app.asar"],
  ]) {
    const [executablePath] = packagedAppCandidates({ platform, ...packagedOptions })
    assert.equal(hostPath(packagedAsarPath({ platform, executablePath })), archive, platform)
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

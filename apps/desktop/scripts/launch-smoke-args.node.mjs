import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { delimiter, join, sep } from "node:path"
import { createRequire } from "node:module"
import { PassThrough } from "node:stream"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import {
  launchSmokeElectronArgs,
  launchSmokeEnvironment,
  launchSmokeTimeoutMs,
  packagedAppCandidates,
  packagedAsarPath,
} from "./launch-smoke-args.mjs"
import * as launch from "./launch-smoke-args.mjs"
import * as live from "./launch-smoke-live-profile.mjs"
import { executableOnPath } from "./desktop-smoke.mjs"
import * as smoke from "./desktop-smoke.mjs"

const execFileAsync = promisify(execFile)
const daemonRequire = createRequire(new URL("../../daemon/package.json", import.meta.url))

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

test("uses the executable returned by PATH discovery for the X server wrapper", async () => {
  const checked = []
  const found = join("/tools with spaces", "xvfb-run")
  const xvfb = await executableOnPath("xvfb-run", {
    env: { PATH: ["/missing", "/tools with spaces"].join(delimiter) },
    checkAccess: async (path) => { checked.push(path); if (path !== found) throw new Error("absent") },
  })
  assert.deepEqual(checked, [join("/missing", "xvfb-run"), found])
  const result = launch.launchSmokeCommand({ platform: "linux", env: {}, electronPath: "/electron", electronArgs: ["/proof"], xvfb })
  assert.deepEqual(result, { command: found, args: ["--auto-servernum", "/electron", "/proof"] })
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
    assert.equal(result.args.includes("--no-sandbox"), false, platform)
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
    if (name === "fleet-client-smoke.mjs") {
      assert.match(source, /observeSmokeDebugging\(desktop, startupSignal\)/u)
      assert.match(source, /debuggingLogFile:\s*chromiumLog/u)
      assert.match(source, /userDataDirectory:\s*electronProfile/u)
    }
  })
}

test("display executable discovery cannot hang the proof before its child starts", { timeout: 1_000 }, async () => {
  await assert.rejects(executableOnPath("xvfb-run", {
    env: { PATH: "/silent" }, timeoutMs: 20, checkAccess: () => new Promise(() => {}),
  }), /Timed out finding xvfb-run/u)
})

test("removes Electron Node-mode variables even when their value is empty", () => {
  const env = launchSmokeEnvironment({ env: { ELECTRON_RUN_AS_NODE: "", electron_run_as_node: "", NODE_OPTIONS: "--inspect" }, profileRoot: "/proof", timeoutMs: 5_000 })
  for (const key of ["ELECTRON_RUN_AS_NODE", "electron_run_as_node", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(env, key), false)
})

function debuggingChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

test("debugging startup reports the exit code and drains the final diagnostic", { timeout: 1_000 }, async () => {
  const child = debuggingChild()
  const controller = new AbortController()
  const observer = smoke.observeSmokeDebugging(child, controller.signal)
  const rejected = assert.rejects(observer.ready, error => {
    assert.match(error.message, /code 17.*signal none/u)
    assert.match(error.message, /stdout:\nbooting/u)
    assert.match(error.message, /stderr:\nfatal startup failure/u)
    return true
  })
  child.stdout.write("booting\n")
  child.emit("exit", 17, null)
  child.stderr.write("fatal startup failure\n")
  child.emit("close", 17, null)
  await rejected
  observer.dispose()
})

test("debugging startup names a signal exit even when the child wrote nothing", { timeout: 1_000 }, async () => {
  const child = debuggingChild()
  const observer = smoke.observeSmokeDebugging(child, new AbortController().signal)
  const rejected = assert.rejects(observer.ready, /code null.*signal SIGTERM[\s\S]*stderr:\n\(empty\)/u)
  child.emit("close", null, "SIGTERM")
  await rejected
  observer.dispose()
})

test("debugging startup preserves split endpoint frames and later output", { timeout: 1_000 }, async () => {
  const child = debuggingChild()
  const observer = smoke.observeSmokeDebugging(child, new AbortController().signal)
  const address = "ws://127.0.0.1:4567/devtools/browser/proof"
  child.stderr.write("DevTools listening on ws://127.0.0.1:4567/devtools/browser/pro")
  child.stderr.write("of\r\n")
  assert.equal(await observer.ready, address)
  child.stdout.write("later output")
  assert.match(observer.output(), /later output/u)
  observer.dispose()
  assert.equal(child.stderr.listenerCount("data"), 0)
  assert.equal(child.listenerCount("close"), 0)
})

test("debugging startup bounds a silent child and includes any exit already observed", { timeout: 1_000 }, async () => {
  const child = debuggingChild()
  const controller = new AbortController()
  const observer = smoke.observeSmokeDebugging(child, controller.signal)
  const rejected = assert.rejects(observer.ready, /deadline.*code 9.*signal none[\s\S]*last diagnostic/u)
  child.emit("exit", 9, null)
  child.stderr.write("last diagnostic")
  controller.abort()
  await rejected
  observer.dispose()
})

test("debugging startup reports an executable launch error", { timeout: 1_000 }, async () => {
  const child = debuggingChild()
  const observer = smoke.observeSmokeDebugging(child, new AbortController().signal)
  const rejected = assert.rejects(observer.ready, /spawn.*ENOENT/u)
  child.emit("error", new Error("spawn electron.exe ENOENT"))
  await rejected
  observer.dispose()
})

test("debugging flags and native file logging survive the Windows argument policy", () => {
  const log = "C:\\Fleet proof\\chromium.log"
  assert.deepEqual(launchSmokeElectronArgs({ platform: "win32", ci: true, desktopRoot: "D:\\desktop", debuggingLogFile: log }), [
    "--headless", "--disable-gpu", "--remote-debugging-port=0", "--enable-logging=file", `--log-file=${log}`, "D:\\desktop",
  ])
})

test("the full application proof gives Electron an explicit private user-data path", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const profile = platform === "win32" ? "C:\\Fleet proof\\electron-profile" : "/tmp/Fleet proof/electron-profile"
    const args = launchSmokeElectronArgs({ platform, ci: true, desktopRoot: "/desktop", userDataDirectory: profile })
    assert.equal(args.filter(arg => arg.startsWith("--user-data-dir=")).length, 1)
    assert.ok(args.includes(`--user-data-dir=${profile}`))
  }
})

test("native startup file diagnostics are bounded and a missing file cannot mask the exit", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-smoke-log-"))
  try {
    const file = join(directory, "chromium.log")
    assert.equal(await smoke.smokeDiagnosticLog(file), "(not created)")
    await writeFile(file, "native check failed\n" + "x".repeat(32_768))
    const log = await smoke.smokeDiagnosticLog(file)
    assert.match(log, /^native check failed/u)
    assert.ok(log.length <= 16_384)
  } finally { await rm(directory, { recursive: true, force: true }) }
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

test("names the license notices every packaged build must carry", () => {
  for (const [platform, notices] of [
    ["linux", ["/dist/linux-unpacked/resources/THIRD_PARTY_NOTICES.txt", "/dist/linux-unpacked/LICENSE.electron.txt", "/dist/linux-unpacked/LICENSES.chromium.html"]],
    ["win32", ["/dist/win-unpacked/resources/THIRD_PARTY_NOTICES.txt", "/dist/win-unpacked/LICENSE.electron.txt", "/dist/win-unpacked/LICENSES.chromium.html"]],
    ["darwin", ["THIRD_PARTY_NOTICES.txt", "LICENSE.electron.txt", "LICENSES.chromium.html"].map((file) => `/dist/mac/Domovoi.app/Contents/Resources/${file}`)],
  ]) {
    const [executablePath] = packagedAppCandidates({ platform, ...packagedOptions })
    assert.equal(typeof launch.packagedNoticePaths, "function", "the package smoke checks the notices")
    assert.deepEqual(launch.packagedNoticePaths({ platform, executablePath }).map(hostPath), notices, platform)
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

// T24: the login-service calls take their lease under the passwd home, which
// the smoke's HOME cannot move. Smokes that start the application turn those
// calls off with the main process's test-only switch, which only an
// unpackaged app reads (src/main/launch-smoke-profile.ts).
test("passes the test-only login service switch before the application directory", () => {
  const args = launchSmokeElectronArgs({ platform: "darwin", ci: false, desktopRoot: "/desktop", loginServiceOff: true })
  assert.deepEqual(args, ["--headless", "--disable-gpu", "--domovoi-test-no-login-service", "/desktop"])
  assert.equal(launch.loginServiceOffSwitch, "--domovoi-test-no-login-service")
})

test("refuses the login service switch for a packaged build, which ignores it", () => {
  assert.throws(
    () => launchSmokeElectronArgs({ platform: "linux", ci: true, desktopRoot: "/desktop", packaged: true, loginServiceOff: true }),
    /packaged/u,
  )
})

test("the main process reads the same switch the runner passes", async () => {
  const source = await readFile(new URL("../src/main/launch-smoke-profile.ts", import.meta.url), "utf8")
  assert.ok(source.includes(`"${launch.loginServiceOffSwitch}"`))
})

test("both smokes that start the application turn the login service off and guard the live profile", async () => {
  for (const name of ["launch-smoke.mjs", "fleet-client-smoke.mjs"]) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8")
    assert.match(source, /loginServiceOff: true/u, name)
    assert.match(source, /liveProfileSnapshot\(/u, name)
    assert.match(source, /liveProfileVerdict\(/u, name)
  }
})

// The daemon's own lease, from its source, claimed and released in a child
// with a scratch passwd home standing in for the real one.
async function claimRealLease(home) {
  const lease = new URL("../../daemon/src/service/operation-lease.ts", import.meta.url).href
  const tsx = pathToFileURL(daemonRequire.resolve("tsx")).href
  await execFileAsync(process.execPath, ["--no-warnings", "--import", tsx, "--input-type=module", "-e",
    `const { claimServiceOperation } = await import(${JSON.stringify(lease)}); claimServiceOperation(process.env.LEASE_HOME).release()`,
  ], { env: { ...process.env, LEASE_HOME: home }, timeout: 30_000 })
}

test("sees the daemon's real lease claimed on an account with no profile", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  try {
    const before = await live.liveProfileSnapshot(home)
    await claimRealLease(home)
    const changed = live.liveProfileChanges(before, await live.liveProfileSnapshot(home))
    assert.ok(changed.includes(join(home, ".domovoi")), changed.join(", "))
    assert.ok(changed.includes(join(home, ".domovoi", "service-operation-lease.sqlite")), changed.join(", "))
  } finally { await rm(home, { recursive: true, force: true }) }
})

// Windows has no mode for the lease's chmod to touch, and an empty database
// claimed and released again leaves nothing else behind there.
test("sees the daemon's real lease claimed again where it already exists", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  try {
    await claimRealLease(home)
    const before = await live.liveProfileSnapshot(home)
    await new Promise(resolve => setTimeout(resolve, 20))
    await claimRealLease(home)
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)),
      [join(home, ".domovoi", "service-operation-lease.sqlite")])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("a profile directory whose mode changes is a change", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  try {
    await mkdir(join(home, ".domovoi"), { mode: 0o755 })
    await chmod(join(home, ".domovoi"), 0o755)
    const before = await live.liveProfileSnapshot(home)
    await chmod(join(home, ".domovoi"), 0o700)
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [join(home, ".domovoi")])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("the verdict names the changed paths, and an unreadable profile is reported, not thrown", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  try {
    const before = await live.liveProfileSnapshot(home)
    assert.equal(await live.liveProfileVerdict(before, home), undefined)
    await mkdir(join(home, ".domovoi"))
    assert.match(await live.liveProfileVerdict(before, home), /changed during the smoke: .*\.domovoi\./u)
    // A home that is a file cannot be listed into: lstat fails with ENOTDIR.
    const file = join(home, "not-a-directory")
    await writeFile(file, "")
    assert.match(await live.liveProfileVerdict(before, file), /could not be read after the smoke/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("a live profile that does not exist is never created by the snapshot, and its creation is a change", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  try {
    const before = await live.liveProfileSnapshot(home)
    await assert.rejects(readFile(join(home, ".domovoi")), { code: "ENOENT" })
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [])
    await mkdir(join(home, ".domovoi"))
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [join(home, ".domovoi")])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("names every change to the service-operation lease and its SQLite files", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  const profile = join(home, ".domovoi")
  const lease = join(profile, "service-operation-lease.sqlite")
  try {
    await mkdir(profile)
    await writeFile(lease, "")
    const before = await live.liveProfileSnapshot(home)
    await writeFile(lease, "written")
    await writeFile(`${lease}-journal`, "")
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [lease, `${lease}-journal`])
  } finally { await rm(home, { recursive: true, force: true }) }
})

// The lease writes nothing into its empty database. What it leaves on the
// file itself is the chmod to 0600, which moves the change time even when the
// mode was already 0600. Windows has no such mode.
test("a chmod to the same mode still counts as a change to the lease", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  const lease = join(home, ".domovoi", "service-operation-lease.sqlite")
  try {
    await mkdir(join(home, ".domovoi"))
    await writeFile(lease, "")
    await chmod(lease, 0o600)
    const before = await live.liveProfileSnapshot(home)
    await new Promise(resolve => setTimeout(resolve, 20))
    await chmod(lease, 0o600)
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [lease])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("ignores files a running daemon on the live profile writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-live-home-"))
  const profile = join(home, ".domovoi")
  try {
    await mkdir(profile)
    await writeFile(join(profile, "service-operation-lease.sqlite"), "")
    const before = await live.liveProfileSnapshot(home)
    await writeFile(join(profile, "state.sqlite"), "written by a running daemon")
    await writeFile(join(profile, "profile-lease.sqlite-journal"), "")
    assert.deepEqual(live.liveProfileChanges(before, await live.liveProfileSnapshot(home)), [])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("the live profile is the passwd home's, not HOME's", () => {
  assert.equal(live.liveProfileHome(), userInfo().homedir)
})

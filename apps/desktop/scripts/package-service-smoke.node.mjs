import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { loginServiceAgentLabel, loginServiceHomePaths, loginServiceUnitFile } from "@getdomovoi/protocol"

import {
  attachMarker,
  checkDefinition,
  checkOwnerRecord,
  checkRuntimeCopy,
  copiedRuntime,
  definitionPaths,
  launchdLabel,
  managerReadback,
  managerReadbackCommand,
  optInVariable,
  packagedResourcesCandidates,
  parseAttachReport,
  parseServiceStatus,
  serviceSmokeEnvironment,
  serviceSmokeRefusal,
  serviceSmokeSkip,
  smokeAccount,
  systemdUnitFile,
} from "./package-service-smoke.mjs"

const optedIn = { CI: "true", [optInVariable]: "1" }

test("the smoke names the service the daemon installs, as the protocol names it", () => {
  assert.equal(launchdLabel, loginServiceAgentLabel)
  assert.equal(systemdUnitFile, loginServiceUnitFile)
  assert.deepEqual(definitionPaths, loginServiceHomePaths)
})

test("Windows skips with a stated reason; macOS and Linux run", () => {
  const reason = serviceSmokeSkip("win32")
  assert.match(reason, /Windows/u)
  assert.match(reason, /not run/u)
  assert.equal(serviceSmokeSkip("darwin"), undefined)
  assert.equal(serviceSmokeSkip("linux"), undefined)
})

test("the smoke refuses a host that has not opted in", () => {
  const macHost = { platform: "darwin", username: "runner", userHome: "/Users/runner", home: "/Users/runner", liveProfileExists: false }
  for (const env of [{}, { CI: "true" }, { [optInVariable]: "1" }, { CI: "1", [optInVariable]: "1" }, { CI: "true", [optInVariable]: "true" }]) {
    const refusal = serviceSmokeRefusal({ ...macHost, env })
    assert.match(refusal, new RegExp(optInVariable, "u"), JSON.stringify(env))
    assert.match(refusal, /Nothing was installed/u)
  }
  assert.equal(serviceSmokeRefusal({ ...macHost, env: optedIn }), undefined)
})

test("the smoke refuses a host that already has a Domovoi profile", () => {
  const refusal = serviceSmokeRefusal({
    platform: "darwin", env: optedIn, username: "runner", userHome: "/Users/runner", home: "/Users/runner", liveProfileExists: true,
  })
  assert.match(refusal, /\/Users\/runner\/\.domovoi/u)
  assert.match(refusal, /Nothing was installed/u)
})

test("on Linux the smoke runs only as the throwaway account in its own home", () => {
  const linux = { platform: "linux", env: optedIn, liveProfileExists: false }
  assert.match(
    serviceSmokeRefusal({ ...linux, username: "runner", userHome: "/home/runner", home: "/home/runner" }),
    new RegExp(smokeAccount, "u"),
  )
  assert.match(
    serviceSmokeRefusal({ ...linux, username: smokeAccount, userHome: `/home/${smokeAccount}`, home: "/tmp/elsewhere" }),
    /systemd user manager/u,
  )
  assert.equal(serviceSmokeRefusal({ ...linux, username: smokeAccount, userHome: `/home/${smokeAccount}`, home: `/home/${smokeAccount}` }), undefined)
})

test("a platform with no login service is refused", () => {
  assert.match(
    serviceSmokeRefusal({ platform: "freebsd", env: optedIn, username: "u", userHome: "/home/u", home: "/home/u", liveProfileExists: false }),
    /freebsd/u,
  )
})

test("the commands get only the isolated home, profile and a loopback port 0", () => {
  const environment = serviceSmokeEnvironment({
    env: {
      PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1001", TMPDIR: "/tmp/runner",
      HOME: "/Users/real", XDG_CONFIG_HOME: "/Users/real/.config", XDG_STATE_HOME: "/Users/real/.local/state",
      XDG_DATA_HOME: "/d", XDG_CACHE_HOME: "/c", NODE_OPTIONS: "--require /x.js", ELECTRON_RUN_AS_NODE: "1",
      DOMOVOI_AUTH_TOKEN: "secret", DOMOVOI_PROFILE_DIR: "/Users/real/.domovoi", domovoi_port: "47831", Home: "/Users/alias",
    },
    home: "/tmp/smoke/home",
    profileDirectory: "/tmp/smoke/profile",
  })
  assert.deepEqual(environment, {
    PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1001", TMPDIR: "/tmp/runner",
    HOME: "/tmp/smoke/home",
    DOMOVOI_PROFILE_DIR: "/tmp/smoke/profile",
    DOMOVOI_HOST: "127.0.0.1",
    DOMOVOI_PORT: "0",
  })
})

test("the packaged resources are looked for where electron-builder writes the unpacked app", () => {
  assert.deepEqual(packagedResourcesCandidates({ platform: "darwin", distDirectory: "/d", productName: "Domovoi" }), [
    join("/d", "mac", "Domovoi.app", "Contents", "Resources"),
    join("/d", "mac-arm64", "Domovoi.app", "Contents", "Resources"),
    join("/d", "mac-universal", "Domovoi.app", "Contents", "Resources"),
  ])
  assert.deepEqual(packagedResourcesCandidates({ platform: "linux", distDirectory: "/d", productName: "Domovoi" }), [
    join("/d", "linux-unpacked", "resources"),
    join("/d", "linux-arm64-unpacked", "resources"),
  ])
})

test("service status lines are read, and anything else is not a status", () => {
  assert.deepEqual(parseServiceStatus("installed, running: /h/x.plist is running\n"), { installed: true, running: true, detail: "/h/x.plist is running" })
  assert.deepEqual(parseServiceStatus("noise\nnot installed, not running: nothing at /h/x\n"), { installed: false, running: false, detail: "nothing at /h/x" })
  assert.deepEqual(parseServiceStatus("installed, not running: stopped\n"), { installed: true, running: false, detail: "stopped" })
  assert.equal(parseServiceStatus("Windows task registration unverified: x\n"), undefined)
  assert.equal(parseServiceStatus(""), undefined)
})

test("the runtime copy must sit under the profile, for this version", () => {
  const stdout = "Copied the daemon runtime out of the app to /p/runtime/0.0.1/abc, so the service does not run from inside the app.\n"
  assert.equal(copiedRuntime(stdout), "/p/runtime/0.0.1/abc")
  assert.equal(copiedRuntime("installed\n"), undefined)
  assert.equal(checkRuntimeCopy({ copy: "/p/runtime/0.0.1/abc", profileDirectory: "/p", version: "0.0.1" }), undefined)
  assert.match(checkRuntimeCopy({ copy: "/q/runtime/0.0.1/abc", profileDirectory: "/p", version: "0.0.1" }), /\/p\/runtime\/0\.0\.1/u)
  assert.match(checkRuntimeCopy({ copy: "/p/runtime/0.0.10/abc", profileDirectory: "/p", version: "0.0.1" }), /not under/u)
  assert.match(checkRuntimeCopy({ copy: "/p/runtime/0.0.1", profileDirectory: "/p", version: "0.0.1" }), /not under/u)
  assert.match(checkRuntimeCopy({ copy: undefined, profileDirectory: "/p", version: "0.0.1" }), /did not say/u)
})

test("the service definition runs the copy, never the app's resources", () => {
  const copy = "/p/runtime/0.0.1/abc"
  const resources = "/dist/mac-arm64/Domovoi.app/Contents/Resources"
  assert.equal(checkDefinition({ text: `<string>${copy}/node/bin/node</string>`, copy, resources }), undefined)
  assert.match(checkDefinition({ text: `<string>${resources}/daemon-runtime/node/bin/node</string>`, copy, resources }), /does not name/u)
  assert.match(checkDefinition({ text: `${copy} ${resources}`, copy, resources }), /names the app/u)
})

test("the daemon that answers must be the one the installed service started", () => {
  const ready = { version: 1, state: "ready", owner: "daemon", serviceRegistrationId: "8a6d2f5e-1b2c-4d3e-9f40-1234567890ab", url: "ws://127.0.0.1:50000/rpc" }
  assert.equal(checkOwnerRecord({ record: ready, registrationId: ready.serviceRegistrationId }), undefined)
  assert.match(checkOwnerRecord({ record: { ...ready, owner: "desktop" }, registrationId: ready.serviceRegistrationId }), /owner desktop/u)
  assert.match(checkOwnerRecord({ record: ready, registrationId: "other" }), /registration/u)
  assert.match(checkOwnerRecord({ record: { ...ready, state: "starting" }, registrationId: ready.serviceRegistrationId }), /starting/u)
  assert.match(checkOwnerRecord({ record: ready, registrationId: undefined }), /registration/u)
  assert.match(checkOwnerRecord({ record: { ...ready, url: "ws://10.0.0.2:50000/rpc" }, registrationId: ready.serviceRegistrationId }), /loopback/u)
  assert.match(checkOwnerRecord({ record: { ...ready, url: "http://127.0.0.1:50000/rpc" }, registrationId: ready.serviceRegistrationId }), /loopback/u)
  assert.match(checkOwnerRecord({ record: { ...ready, url: "not a url" }, registrationId: ready.serviceRegistrationId }), /loopback/u)
})

test("the service manager itself is asked whether the service is loaded", () => {
  assert.deepEqual(managerReadbackCommand("darwin", 501), { command: "launchctl", args: ["print", `gui/501/${launchdLabel}`] })
  assert.deepEqual(managerReadbackCommand("linux", 1001), {
    command: "systemctl", args: ["--user", "show", systemdUnitFile, "--property=LoadState", "--property=ActiveState", "--property=FragmentPath"],
  })

  const printed = `gui/501/${launchdLabel} = {\n\tactive count = 1\n\tpath = /h/Library/LaunchAgents/${launchdLabel}.plist\n\tstate = running\n}\n`
  assert.deepEqual(managerReadback("darwin", { code: 0, stdout: printed, stderr: "" }), { loaded: true, active: true, path: `/h/Library/LaunchAgents/${launchdLabel}.plist` })
  assert.deepEqual(managerReadback("darwin", { code: 113, stdout: "", stderr: `Could not find service "${launchdLabel}" in domain for user gui: 501\n` }), { loaded: false, active: false })
  assert.throws(() => managerReadback("darwin", { code: 5, stdout: "", stderr: "Input/output error" }), /launchctl/u)
  assert.throws(() => managerReadback("darwin", { code: 113, stdout: "", stderr: "something else" }), /launchctl/u)

  assert.deepEqual(
    managerReadback("linux", { code: 0, stdout: "LoadState=loaded\nActiveState=active\nFragmentPath=/h/.config/systemd/user/domovoid.service\n", stderr: "" }),
    { loaded: true, active: true, path: "/h/.config/systemd/user/domovoid.service" },
  )
  assert.deepEqual(managerReadback("linux", { code: 0, stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\n", stderr: "" }), { loaded: false, active: false })
  assert.throws(() => managerReadback("linux", { code: 1, stdout: "", stderr: "Failed to connect to bus" }), /systemctl/u)
  assert.throws(() => managerReadback("linux", { code: 0, stdout: "ActiveState=active\n", stderr: "" }), /LoadState/u)
})

test("every script that runs electron-builder, package:dir included, loads the signing policy and never publishes", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const builders = Object.entries(manifest.scripts).filter(([, command]) => command.includes("electron-builder"))
  assert.ok(builders.some(([name]) => name === "package:dir"))
  for (const [name, command] of builders) {
    assert.match(command, /--config electron-builder\.cjs/u, name)
    assert.match(command, /--publish never/u, name)
  }
})

test("the attach report is read from its marker line only", () => {
  const report = { kind: "attached", owner: "daemon", url: "ws://127.0.0.1:1", machine: { id: "m", version: "0.0.1" } }
  assert.deepEqual(parseAttachReport(`noise\n${attachMarker}${JSON.stringify(report)}\n`), report)
  assert.equal(parseAttachReport("noise only\n"), undefined)
})

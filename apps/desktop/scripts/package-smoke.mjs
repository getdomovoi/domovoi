#!/usr/bin/env node

// Proves the built installer, not the repository checkout. A packaged Electron
// application fails in ways an unpackaged one cannot: the archive hides native
// modules from dlopen, and worker entry points resolve to paths inside it. Both
// are checked here against the real artifact before the application is launched.

import { constants } from "node:fs"
import { access, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  launchSmokeElectronArgs,
  launchSmokeEnvironment,
  launchSmokeTimeoutMs,
  packagedAppCandidates,
  packagedAsarPath,
} from "./launch-smoke-args.mjs"
import {
  assertDaemonProfile,
  assertSmokeProcess,
  createSmokeProfile,
  reportSmokeOutput,
  runSmokeProcess,
  successMarker,
} from "./desktop-smoke.mjs"

const description = "desktop package smoke"
const probeMarker = "DOMOVOI_PACKAGED_NATIVE_PROBE "
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// yaml is already a daemon dependency; resolving it from there keeps the
// packaging configuration readable without a second copy in this workspace.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url))
const { parse } = require("yaml")

const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"))
const config = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"))
const platformKey = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"
const productName = manifest.productName ?? manifest.name
const executableName = config[platformKey]?.executableName ?? config.executableName ?? productName
const distDirectory = resolve(desktopRoot, config.directories?.output ?? "dist")

const candidates = packagedAppCandidates({
  platform: process.platform,
  distDirectory,
  productName,
  executableName,
})
let executablePath
for (const candidate of candidates) {
  if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
    executablePath = candidate
    break
  }
}
if (!executablePath) {
  throw new Error(`${description} found no packaged application. Run pnpm package first; looked for ${candidates.join(", ")}`)
}
const asar = packagedAsarPath({ platform: process.platform, executablePath })
if (!await access(asar, constants.R_OK).then(() => true, () => false)) {
  throw new Error(`${description} found no application archive at ${asar}`)
}

const timeoutMs = launchSmokeTimeoutMs({ platform: process.platform, env: process.env })

// Native modules first. A launch that fails later is much harder to read when
// the cause is a binding the archive never unpacked.
const probe = await runSmokeProcess({
  command: executablePath,
  args: [join(desktopRoot, "scripts", "packaged-native-probe.cjs"), asar],
  cwd: desktopRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  timeoutMs,
})
if (probe.timedOut) throw new Error(`${description} native probe timed out after ${timeoutMs}ms`)
if (probe.code !== 0) {
  reportSmokeOutput(probe)
  throw new Error(`${description} native probe exited with code ${probe.code ?? "null"}`)
}
const probeLine = probe.stdout.split(/\r?\n/u).find((line) => line.startsWith(probeMarker))
if (!probeLine) {
  reportSmokeOutput(probe)
  throw new Error(`${description} native probe printed no report`)
}
const report = JSON.parse(probeLine.slice(probeMarker.length))
const failures = []
if (!report.nodePty?.loaded) failures.push(`node-pty did not load: ${report.nodePty?.error ?? "unknown"}`)
if (!report.nodePty?.wroteToPty) failures.push("node-pty loaded but opened no working pseudoterminal")
if (!report.keyring?.loaded) failures.push(`@napi-rs/keyring did not load: ${report.keyring?.error ?? "unknown"}`)
if (!report.keyringInWorker?.loaded) {
  failures.push(`@napi-rs/keyring did not load in a worker thread: ${report.keyringInWorker?.error ?? "unknown"}`)
}
if (!report.daemonKeyringWorker?.replied) {
  failures.push(`the daemon keyring worker did not answer from the archive: ${report.daemonKeyringWorker?.error ?? "unknown"}`)
}
if (failures.length > 0) throw new Error(`${description} native modules: ${failures.join("; ")}`)
// The keychain itself is a machine fact, not a packaging one. A build host
// without a secret service still proves every module loaded.
process.stdout.write(
  `packaged native modules loaded from ${asar}: node-pty pid ${report.nodePty.pid}, `
  + `@napi-rs/keyring on the main thread and in a worker, daemon keyring worker replied `
  + `(keychain answered: ${report.daemonKeyringWorker.keychainAnswered})\n`,
)

const profileRoot = await createSmokeProfile("domovoi-desktop-package-")
let result
try {
  result = await runSmokeProcess({
    command: executablePath,
    args: launchSmokeElectronArgs({
      platform: process.platform,
      ci: process.env.CI === "true",
      desktopRoot,
      packaged: true,
    }),
    cwd: desktopRoot,
    env: launchSmokeEnvironment({ env: process.env, profileRoot, timeoutMs }),
    timeoutMs,
  })
  assertSmokeProcess(result, { timeoutMs, description })
  await assertDaemonProfile(profileRoot, description)
  process.stdout.write(`${executablePath}\n${successMarker}\n`)
} catch (error) {
  if (result) reportSmokeOutput(result)
  throw error
} finally {
  await rm(profileRoot, { force: true, recursive: true })
}

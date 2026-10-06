#!/usr/bin/env node

// Proves the packaged app's login service on a disposable host: the daemon
// runtime the built app ships installs a real per-user service, the service
// manager starts it, the desktop's own attach path reaches it and system.hello
// answers, status reads it back, and removal leaves nothing loaded or on disk.
// docs/desktop-launch-smoke.md says what this proves and what it does not.
//
// It changes the service manager of the account that runs it, so it refuses
// to run anywhere but a host that has opted in (CI=true and
// DOMOVOI_SERVICE_SMOKE_DISPOSABLE_HOST=1) and has no Domovoi profile. Two
// facts make that necessary, and a temporary HOME does not remove either:
//
// - launchd binds the fixed label sh.domovoi.domovoid in the account's one
//   gui/<uid> domain, whichever plist it was loaded from; and
// - the installer takes its service-operation lease under the account's own
//   home, read from the password database rather than HOME
//   (nodeServiceEffects in apps/daemon/src/service/install.ts).
//
// On Linux the systemd user manager reads unit files only under the home it
// was started with, so a temporary HOME cannot be installed into at all. The
// Linux leg runs as a throwaway account the workflow creates, in that
// account's own home.

import { constants, existsSync, readdirSync, realpathSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import { reportSmokeOutput, runSmokeProcess } from "./desktop-smoke.mjs"

export const optInVariable = "DOMOVOI_SERVICE_SMOKE_DISPOSABLE_HOST"
// Created by .github/workflows/ci.yml for the Linux leg; never a person.
export const smokeAccount = "domovoi-smoke"
// The names the daemon installs under. The test pins them to
// packages/protocol/src/login-service.ts, which the Linux leg cannot import
// from the copy it runs.
export const launchdLabel = "sh.domovoi.domovoid"
export const systemdUnitFile = "domovoid.service"
export const definitionPaths = {
  linux: `.config/systemd/user/${systemdUnitFile}`,
  darwin: `Library/LaunchAgents/${launchdLabel}.plist`,
}
export const attachMarker = "DOMOVOI_SERVICE_SMOKE_ATTACH "
export const successMarker = "DOMOVOI_PACKAGE_SERVICE_SMOKE_OK"

const description = "packaged service smoke"
const commandTimeoutMs = 30_000
const installTimeoutMs = 180_000
const removeTimeoutMs = 120_000
const attachAttemptMs = 15_000
const attachWindowMs = 90_000
const goneWindowMs = 30_000

export function serviceSmokeSkip(platform) {
  if (platform !== "win32") return undefined
  return "The packaged service smoke does not run on Windows yet. Logon task supervision there is still changing, "
    + "so this leg installs nothing and proves nothing about the Windows service. The macOS and Linux legs run the full "
    + "install, attach, status and removal."
}

// The entries of the account's ~/.domovoi that make it a Domovoi profile:
// everything but the installer's own service-operation lease, which any
// service command (and the daemon's scripted launchd tests, earlier in the
// macOS job) creates there whatever HOME says.
export function profileEntries(names) {
  return names.filter((name) => !/^service-operation-lease\.sqlite(?:-journal)?$/u.test(name))
}

// The reason this host may not run the smoke, or undefined when it may.
// profileEntries: what profileEntries() keeps of the account's ~/.domovoi.
export function serviceSmokeRefusal({ platform, env, username, userHome, home, profileEntries: entries }) {
  if (platform !== "darwin" && platform !== "linux") {
    return `${description} has no login service to install on ${platform}. Nothing was installed.`
  }
  if (env.CI !== "true" || env[optInVariable] !== "1") {
    return `${description} installs a real login service for the account that runs it. Run it only on a disposable `
      + `host, with CI=true and ${optInVariable}=1. Nothing was installed.`
  }
  if (platform === "linux" && username !== smokeAccount) {
    return `${description} runs on Linux only as the throwaway ${smokeAccount} account, not as ${username}. Nothing was installed.`
  }
  if (platform === "linux" && home !== userHome) {
    return `${description} needs HOME to be ${userHome}, the only home the account's systemd user manager reads units from. `
      + "Nothing was installed."
  }
  if (entries.length > 0) {
    return `${join(userHome, ".domovoi")} holds a Domovoi profile (${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ", ..." : ""}). `
      + `${description} will not share an account with one. Nothing was installed.`
  }
  return undefined
}

// The commands see the isolated home and profile and nothing that could point
// them elsewhere. Windows-style case aliases are removed too.
export function serviceSmokeEnvironment({ env, home, profileDirectory }) {
  const replaced = new Set(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"])
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => {
    const upper = key.toUpperCase()
    return !upper.startsWith("DOMOVOI_") && !replaced.has(upper)
  }))
  return { ...inherited, HOME: home, DOMOVOI_PROFILE_DIR: profileDirectory, DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0" }
}

// Where electron-builder --dir leaves the unpacked app's resources.
export function packagedResourcesCandidates({ platform, distDirectory, productName }) {
  if (platform === "darwin") {
    return ["mac", "mac-arm64", "mac-universal"].map((directory) =>
      join(distDirectory, directory, `${productName}.app`, "Contents", "Resources"))
  }
  return ["linux-unpacked", "linux-arm64-unpacked"].map((directory) => join(distDirectory, directory, "resources"))
}

// `domovoid service status` prints one "<installed>, <running>: <detail>" line.
export function parseServiceStatus(stdout) {
  const match = /^(installed|not installed), (running|not running): (.*)$/mu.exec(stdout)
  if (!match) return undefined
  return { installed: match[1] === "installed", running: match[2] === "running", detail: match[3] }
}

export function copiedRuntime(stdout) {
  return /^Copied the daemon runtime out of the app to (.+), so the service does not run from inside the app\.$/mu.exec(stdout)?.[1]
}

export function checkRuntimeCopy({ copy, profileDirectory, version }) {
  if (copy === undefined) return "service install did not say where it copied the daemon runtime"
  const parent = join(profileDirectory, "runtime", version)
  if (!copy.startsWith(`${parent}${sep}`)) return `the runtime copy ${copy} is not under ${parent}`
  return undefined
}

export function checkDefinition({ text, copy, resources }) {
  if (!text.includes(copy)) return `the service definition does not name the runtime copy ${copy}`
  if (text.includes(resources)) return `the service definition names the app's resources ${resources}`
  return undefined
}

// The owner record the profile publishes, as the desktop reads it before it
// attaches: a ready daemon, started by this install's registration, on loopback.
export function checkOwnerRecord({ record, registrationId }) {
  if (record?.state !== "ready") return `the profile's owner record is ${record?.state ?? "missing"}, not ready`
  if (record.owner !== "daemon") return `the profile's owner record names owner ${record.owner}, not the service daemon`
  if (registrationId === undefined || record.serviceRegistrationId !== registrationId) {
    return "the running daemon does not carry this install's service registration"
  }
  const url = URL.canParse(record.url) ? new URL(record.url) : undefined
  if (url === undefined || !["ws:", "wss:"].includes(url.protocol) || url.hostname !== "127.0.0.1") {
    return `the running daemon listens at ${record.url}, not on loopback`
  }
  return undefined
}

export function managerReadbackCommand(platform, uid) {
  if (platform === "darwin") return { command: "launchctl", args: ["print", `gui/${uid}/${launchdLabel}`] }
  return { command: "systemctl", args: ["--user", "show", systemdUnitFile, "--property=LoadState", "--property=ActiveState", "--property=FragmentPath"] }
}

// The manager's own answer, not the daemon's. Exit codes are enumerated: any
// answer not named here is a failure to read, never "not loaded".
export function managerReadback(platform, { code, stdout, stderr }) {
  if (platform === "darwin") {
    if (code === 113 && /could not find service/iu.test(`${stdout}${stderr}`)) return { loaded: false, active: false }
    if (code !== 0) throw new Error(`launchctl print exited with ${code}: ${stderr.trim() || stdout.trim()}`)
    const paths = [...stdout.matchAll(/^\tpath = ([^\r\n]+)\r?$/gmu)]
    if (paths.length !== 1) throw new Error("launchctl print did not say which file the job came from")
    return { loaded: true, active: /^\tstate = running\r?$/mu.test(stdout), path: paths[0][1].trim() }
  }
  if (code !== 0) throw new Error(`systemctl --user show exited with ${code}: ${stderr.trim() || stdout.trim()}`)
  const field = (name) => new RegExp(`^${name}=(.*)$`, "mu").exec(stdout)?.[1]
  const loadState = field("LoadState")
  const activeState = field("ActiveState")
  if (loadState === undefined) throw new Error("systemctl --user show printed no LoadState")
  if (activeState === undefined) throw new Error("systemctl --user show printed no ActiveState")
  // Independent in systemd: a unit whose file was deleted can still run, and
  // any load state but not-found (masked, error, bad-setting) is still held.
  const active = activeState !== "inactive" && activeState !== "failed"
  if (loadState === "not-found") return { loaded: false, active }
  return { loaded: true, active, path: field("FragmentPath") ?? "" }
}

// Gone means the manager holds neither the definition nor a running job.
export function serviceGone(state) {
  return !state.loaded && !state.active
}

// The work directory holds the runtime copy and profile a loaded service may
// still run from, so it is deleted only when nothing was installed or the
// manager confirms the service gone. An unreadable manager (undefined) keeps it.
export function keepWork({ attempted, state }) {
  return attempted && (state === undefined || !serviceGone(state))
}

export function parseAttachReport(stdout) {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(attachMarker))
  return line === undefined ? undefined : JSON.parse(line.slice(attachMarker.length))
}

// Run by the app's shipped Node, from the shipped daemon module: the same
// attach-only acquisition the desktop uses after it installs the service
// (DesktopDaemon.attachOnly), then one explicit system.hello on the endpoint
// it returns, speaking the protocol and build version the shipped daemon was
// built with. The bearer stays in this process; only the answer is printed.
// A hello that fails is reported as such, so the caller stops waiting.
export const attachSource = `
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
const [moduleUrl, home, budget] = process.argv.slice(2)
const marker = ${JSON.stringify(attachMarker)}
const report = (value) => process.stdout.write(marker + JSON.stringify(value) + "\\n", () => process.exit(0))
const { acquireLocalDaemon } = await import(moduleUrl)
const { buildVersion, protocolVersion } = await import(pathToFileURL(createRequire(moduleUrl).resolve("@getdomovoi/protocol")).href)
const handle = await acquireLocalDaemon({ mode: "attach-only", timeoutMs: Number(budget), environment: { ...process.env }, homeDirectory: home })
if (handle.kind !== "attached") {
  report({ kind: handle.kind, reason: handle.reason })
} else {
  try {
    const machine = await new Promise((resolve, reject) => {
      const socket = new WebSocket(handle.endpoint.url)
      const timer = setTimeout(() => { socket.close(); reject(new Error("system.hello did not answer")) }, Number(budget))
      socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello",
        params: { client: "desktop", clientVersion: buildVersion, protocolVersion, authToken: handle.endpoint.token } })))
      socket.addEventListener("message", (event) => {
        const reply = JSON.parse(String(event.data))
        if (reply.id !== 1) return
        clearTimeout(timer)
        socket.close()
        if (reply.error) reject(new Error("system.hello was refused: " + reply.error.message))
        else resolve(reply.result.machine)
      })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("the endpoint socket failed")) })
    })
    report({ kind: "attached", owner: handle.owner, url: handle.endpoint.url, machine: { id: machine.id, version: machine.version } })
  } catch (error) {
    report({ kind: "hello-failed", message: error instanceof Error ? error.message : String(error) })
  } finally {
    handle.detach()
  }
}
`

function argumentValue(argv, name) {
  const at = argv.indexOf(name)
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

const readable = (path) => access(path, constants.R_OK).then(() => true, () => false)

async function main({ argv, env, platform }) {
  const skip = serviceSmokeSkip(platform)
  if (skip) {
    process.stdout.write(`${skip}\n`)
    return
  }
  const { uid, username, homedir: userHome } = userInfo()
  // Absent is the only answer that means empty; any other failure to list it
  // stops the run rather than passing as no profile.
  const listed = (() => {
    try {
      return readdirSync(join(userHome, ".domovoi"))
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
  })()
  const refusal = serviceSmokeRefusal({ platform, env, username, userHome, home: env.HOME, profileEntries: profileEntries(listed) })
  if (refusal) throw new Error(refusal)

  const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const distDirectory = resolve(argumentValue(argv, "--dist") ?? join(desktopRoot, "dist"))
  const productName = platform === "darwin"
    ? (({ productName: named, name }) => named ?? name)(JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")))
    : undefined
  let resources
  for (const candidate of packagedResourcesCandidates({ platform, distDirectory, productName })) {
    if (await readable(join(candidate, "daemon-runtime"))) {
      resources = await realpath(candidate)
      break
    }
  }
  if (!resources) throw new Error(`${description} found no packaged app under ${distDirectory}. Run pnpm --filter @getdomovoi/desktop package:dir first.`)
  const runtime = join(resources, "daemon-runtime")
  const node = join(runtime, "node", "bin", "node")
  const entry = join(runtime, "daemon", "dist", "index.js")
  const publicModule = pathToFileURL(join(runtime, "daemon", "dist", "public.js")).href
  for (const required of [node, entry, fileURLToPath(publicModule)]) {
    if (!await readable(required)) throw new Error(`${description} found no shipped daemon runtime file at ${required}`)
  }
  const { version } = JSON.parse(await readFile(join(runtime, "daemon", "package.json"), "utf8"))

  const readback = managerReadbackCommand(platform, uid)
  const askManager = async () => managerReadback(platform, await runSmokeProcess({ ...readback, cwd: userHome, env, timeoutMs: commandTimeoutMs }))
  if (!serviceGone(await askManager())) {
    throw new Error(`A Domovoi login service is already loaded for ${username}. ${description} will not replace it. Nothing was installed.`)
  }
  // On Linux the definition goes in the account's own home, so an earlier one
  // there is refused before anything is created. A macOS home here is new.
  if (platform === "linux" && existsSync(join(userHome, definitionPaths.linux))) {
    throw new Error(`${join(userHome, definitionPaths.linux)} already exists. Nothing was installed.`)
  }

  // The work directory holds the profile and the attach script, and on macOS
  // the temporary home. Real paths, because launchd reports one.
  const work = await mkdtemp(join(platform === "darwin" ? await realpath(tmpdir()) : userHome, "domovoi-service-smoke-"))
  const home = platform === "darwin" ? join(work, "home") : userHome
  const profileDirectory = join(work, "profile")
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(profileDirectory, { mode: 0o700 })
  const definition = join(home, definitionPaths[platform])
  const configuration = join(home, ".domovoi", "service.json")
  const attachScript = join(work, "attach.mjs")
  await writeFile(attachScript, attachSource, { mode: 0o600 })
  const commandEnv = serviceSmokeEnvironment({ env, home, profileDirectory })
  const service = (verb, timeoutMs) => runSmokeProcess({ command: node, args: [entry, "service", verb], cwd: home, env: commandEnv, timeoutMs })
  const attach = () => runSmokeProcess({
    command: node, args: [attachScript, publicModule, home, String(attachAttemptMs)], cwd: home, env: commandEnv, timeoutMs: attachAttemptMs + 5_000,
  })
  const step = (text) => process.stdout.write(`${text}\n`)
  const fail = (result, message) => {
    if (result) reportSmokeOutput(result)
    throw new Error(`${description}: ${message}`)
  }

  let attempted = false
  let removed = false
  try {
    attempted = true
    const installed = await service("install", installTimeoutMs)
    if (installed.timedOut || installed.code !== 0) fail(installed, `service install exited with ${installed.timedOut ? "a timeout" : installed.code}`)
    const copy = copiedRuntime(installed.stdout)
    const copyProblem = checkRuntimeCopy({ copy, profileDirectory, version })
    if (copyProblem) fail(installed, copyProblem)
    const definitionProblem = checkDefinition({ text: await readFile(definition, "utf8"), copy, resources })
    if (definitionProblem) fail(installed, definitionProblem)
    step(`installed from ${entry}: ${definition} runs the copy at ${copy}`)

    const status = await service("status", commandTimeoutMs)
    const read = parseServiceStatus(status.stdout)
    if (status.code !== 0 || !read?.installed || !read.running) fail(status, "service status did not read the service back installed and running")
    step(`service status: installed, running: ${read.detail}`)
    const loaded = await askManager()
    if (!loaded.loaded || !loaded.active || loaded.path !== definition) {
      fail(undefined, `the service manager reports ${JSON.stringify(loaded)}, not ${definition} loaded and running`)
    }
    step(`service manager: ${loaded.path} loaded and running`)

    let attached
    let last
    for (const until = Date.now() + attachWindowMs; Date.now() < until;) {
      last = await attach()
      attached = last.code === 0 ? parseAttachReport(last.stdout) : undefined
      // Not ready yet is a refusal; a daemon that answered and failed hello
      // will not start answering, so the wait ends there.
      if (attached?.kind === "attached" || attached?.kind === "hello-failed") break
      await delay(1_000)
    }
    if (attached?.kind !== "attached") fail(last, `the desktop attach path did not reach the service within ${attachWindowMs}ms (${JSON.stringify(attached)})`)
    const record = JSON.parse(await readFile(join(profileDirectory, "local-owner.json"), "utf8"))
    const { registrationId } = JSON.parse(await readFile(configuration, "utf8"))
    const ownerProblem = checkOwnerRecord({ record, registrationId })
    if (ownerProblem) fail(undefined, ownerProblem)
    if (attached.owner !== "daemon" || attached.url !== record.url || attached.machine.id !== record.machineId || attached.machine.version !== version) {
      fail(last, `the attached daemon ${JSON.stringify(attached)} is not the service daemon ${record.url} at ${version}`)
    }
    step(`attached as the desktop does: system.hello answered from ${attached.url}, machine ${attached.machine.id}, version ${attached.machine.version}`)

    const removal = await service("remove", removeTimeoutMs)
    if (removal.timedOut || removal.code !== 0) fail(removal, `service remove exited with ${removal.timedOut ? "a timeout" : removal.code}`)
    removed = true
    const after = await service("status", commandTimeoutMs)
    const gone = parseServiceStatus(after.stdout)
    if (after.code !== 1 || gone?.installed !== false || gone.running) fail(after, "service status did not read the service back removed")
    step(`service status after removal: not installed, not running: ${gone.detail}`)
    for (const path of [definition, configuration]) {
      if (existsSync(path)) fail(undefined, `${path} is still there after removal`)
    }
    let managerState
    let refused
    for (const until = Date.now() + goneWindowMs; Date.now() < until;) {
      managerState = await askManager()
      last = await attach()
      refused = last.code === 0 ? parseAttachReport(last.stdout) : undefined
      if (serviceGone(managerState) && refused?.kind === "refused") break
      await delay(1_000)
    }
    if (!serviceGone(managerState)) fail(undefined, `the service manager still reports ${JSON.stringify(managerState)} ${goneWindowMs}ms after removal`)
    if (refused?.kind !== "refused") fail(last, `a daemon still answered for the profile ${goneWindowMs}ms after removal`)
    step(`after removal: manager has no service, ${definition} and ${configuration} are gone, attach is refused (${refused.reason})`)
    step(successMarker)
  } finally {
    let state
    if (attempted) {
      if (!removed) {
        const cleanup = await service("remove", removeTimeoutMs).catch((error) => ({ code: null, stdout: "", stderr: String(error) }))
        if (cleanup.code !== 0) reportSmokeOutput(cleanup)
      }
      state = await askManager().catch(() => undefined)
    }
    if (keepWork({ attempted, state })) process.stderr.write(`${description} kept ${work}: the manager reports ${JSON.stringify(state ?? "nothing readable")} for the service, which may still run from it.\n`)
    else await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main({ argv: process.argv.slice(2), env: process.env, platform: process.platform })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

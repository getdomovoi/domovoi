import { execFile } from "node:child_process"
import { chmod, link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, posix, win32 } from "node:path"
import { promisify } from "node:util"

import { bootstrapDaemon, defaultBootstrapInactivityTimeoutMs, defaultBootstrapTimeoutMs } from "./bootstrap-download.mjs"
import { bootstrapDeadline, defaultCleanupTimeoutMs, removeStaging, validateBootstrapTimeout } from "./bootstrap-deadline.mjs"
import { pinnedSha256 } from "./bootstrap-plan.mjs"
import { hashRuntimeFile, readRuntimeJson, runtimePlatform, validateRuntimeLock, verifyInstalledRuntime } from "./runtime-verification.mjs"

const execute = promisify(execFile)
export const minimumBootstrapNpm = "10.0.0"
const npmRemedy = `Bootstrap requires npm ${minimumBootstrapNpm} or newer bundled with Node. Install a supported Node distribution including npm`

export function nodePtyBuildEnvironment(platform, environment) {
  const env = { ...environment }
  if (platform.os === "linux" && platform.libc !== "glibc") {
    // node-pty's platform/architecture prebuild path does not distinguish libc.
    // Its reviewed install hook removes those prebuilds when this flag is true.
    // An inherited false, including differently cased npm keys, must not win.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "npm_config_build_from_source") delete env[key]
    }
    env.npm_config_build_from_source = "true"
  }
  return env
}

export async function runBootstrapCommand(command, args, { cwd, deadline, env }) {
  deadline.check()
  return await deadline.run(() => execute(command, args, {
    cwd, env, signal: deadline.signal, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
  }))
}

async function bundledNpm(deadline, run) {
  // Use the npm belonging to this Node, not a .cmd shell wrapper or an unrelated
  // package manager elsewhere on PATH. All arguments remain literal on Windows.
  const base = dirname(process.execPath)
  for (const entry of [join(base, "node_modules/npm/bin/npm-cli.js"), join(base, "../lib/node_modules/npm/bin/npm-cli.js")]) {
    let info
    try { info = await deadline.run(() => lstat(entry)) } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    if (!info.isFile()) continue
    let result
    try { result = await deadline.run(() => run(process.execPath, [entry, "--version"], { deadline })) }
    catch (error) {
      deadline.check()
      throw new Error(`${npmRemedy}. ${error.message}`, { cause: error })
    }
    const match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(result.stdout)
    if (!match || Number(match[1]) < 10) throw new Error(`${npmRemedy}; reported version ${JSON.stringify(result.stdout.trim())}`)
    return { entry }
  }
  throw new Error(`${npmRemedy}; npm-cli.js was not found beside ${process.execPath}`)
}

async function privateDirectory(directory, deadline, run) {
  if (process.platform !== "win32") { await deadline.run(() => chmod(directory, 0o700)); return }
  const system = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  const identity = await deadline.run(() => run(win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { deadline }))
  const sid = /\bS-1-(?:\d+-)+\d+\b/.exec(identity.stdout)?.[0]
  if (!sid) throw new Error("Could not identify the current Windows user for private bootstrap staging")
  // Files extracted and installed below this directory inherit only this SID's
  // grant, not an arbitrary destination directory's wider inherited ACL.
  await deadline.run(() => run(win32.join(system, "icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { deadline }))
}

async function extractRuntime(archive, directory, run, deadline) {
  const options = { deadline }
  const listing = await deadline.run(() => run("tar", ["-tzf", archive], options))
  const entries = listing.stdout.trim().split(/\r?\n/)
  const names = new Set()
  if (entries.length > 10_000) throw new Error("Runtime archive has too many entries")
  for (const entry of entries) {
    const path = entry.replace(/\/$/, "")
    if (!/^package(?:\/[A-Za-z0-9@._-]+)*$/.test(path) || path.split("/").some((part) => part === "." || part === "..") || names.has(path)) {
      throw new Error(`Unsafe or duplicate runtime archive path: ${entry}`)
    }
    names.add(path)
  }
  // Reject links and special files before extraction. The package contract ships
  // regular files and directories only. No archive-supplied symlink may redirect
  // a later write, even inside the private staging directory.
  const types = await deadline.run(() => run("tar", ["-tvzf", archive], options))
  if (types.stdout.trim().split(/\r?\n/).some((line) => !/^[-d]/.test(line))) {
    throw new Error("Runtime archive contains a link or special file")
  }
  await deadline.run(() => run("tar", ["-xzf", archive, "-C", directory, "--no-same-owner", "--no-same-permissions"], options))
}

async function lockedInput(directory, version, deadline) {
  const manifest = await readRuntimeJson(join(directory, "runtime/package.json"), deadline)
  const lock = await readRuntimeJson(join(directory, "runtime/lock.json"), deadline)
  validateRuntimeLock(lock, manifest, version)
  const protocol = `sha512-${await hashRuntimeFile(join(directory, "runtime/protocol.tgz"), "sha512", deadline)}`
  if (lock.packages["node_modules/@getdomovoi/protocol"].integrity !== protocol) throw new Error("Same-release protocol archive failed integrity verification")
  return { lock, manifest, lockSha256: await hashRuntimeFile(join(directory, "runtime/lock.json"), "sha256", deadline) }
}

async function verifyNativeRuntime(directory, lock, deadline, run) {
  if (!lock.packages["node_modules/node-pty"]) return
  // Successful npm output is not evidence that the native addon loads in this
  // Node/libc combination. Probe only the verified installed package, in a
  // child process spending the original bootstrap deadline, before publication
  // and on reuse. Never start a daemon or create a profile during installation.
  try {
    // The pinned node-pty loads ConPTY lazily on Windows. Importing its public
    // entry alone would not exercise the binding on that platform. Use its own
    // loader for the selected native addon without spawning a terminal.
    const probe = 'const root = process.argv[1]; require(root); require(require("node:path").join(root, "lib/utils.js")).loadNativeModule(process.platform === "win32" ? "conpty" : "pty")'
    await deadline.run(() => run(process.execPath, ["--input-type=commonjs", "--eval", probe,
      join(directory, "node_modules/node-pty")], { cwd: directory, deadline }))
  } catch (error) {
    deadline.check()
    throw new Error(`The native terminal module could not load at ${directory}. Check the Node version and native build toolchain, then install into a new destination; existing installations were not replaced. ${error.message}`, { cause: error })
  }
}

async function existingRuntime(release, archive, deadline, run) {
  let receipt
  try { receipt = await readRuntimeJson(join(release, "runtime.json"), deadline, 16 * 1024) }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error }
  if (receipt.format !== 1 || receipt.version !== archive.version || receipt.sha256 !== archive.sha256 ||
      typeof receipt.directory !== "string" || !/^\.runtime-[A-Za-z0-9_-]+\/package$/.test(receipt.directory)) {
    throw new Error(`Existing runtime receipt at ${release} differs from this release. Nothing was replaced`)
  }
  const directory = join(release, receipt.directory)
  const input = await lockedInput(directory, archive.version, deadline)
  if (receipt.lockSha256 !== input.lockSha256) throw new Error(`Existing runtime lock changed at ${directory}. Nothing was replaced`)
  await verifyInstalledRuntime(directory, input.lock, deadline)
  await verifyNativeRuntime(directory, input.lock, deadline, run)
  return { ...archive, runtimePath: directory }
}

export async function installBootstrapDaemon(options) {
  const timeoutMs = options.timeoutMs ?? defaultBootstrapTimeoutMs
  pinnedSha256(options.expectedSha256)
  validateBootstrapTimeout(options.inactivityTimeoutMs === undefined ? defaultBootstrapInactivityTimeoutMs : options.inactivityTimeoutMs)
  const deadline = bootstrapDeadline(timeoutMs,
    `Bootstrap exceeded ${timeoutMs} ms, including installation and verification; inspect ${options.destination} before retrying`)
  // The total alone says a machine was slow. It does not say whether the
  // download, the dependency install, the native build or a verification pass
  // held the clock, and only the expiring step can answer that. Nothing here
  // changes what is cancelled or when: an expiry still rejects from the same
  // operation, and only the reported reason gains the step and its elapsed time.
  const during = async (step, operation) => {
    const startedAt = performance.now()
    try {
      return await operation()
    } catch (error) {
      if (error !== deadline.signal.reason) throw error
      throw new Error(`${error.message}. It expired during ${step}, ${Math.round(performance.now() - startedAt)} ms into that step`,
        { cause: error })
    }
  }
  const run = options.run ?? runBootstrapCommand
  const remove = options.remove ?? rm
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs
  let release
  let created
  let published
  let keep = false
  let result
  let failure
  try {
    const npm = await during("the npm lookup", () => bundledNpm(deadline, run))
    const archive = await during("the release archive download", () => bootstrapDaemon({ ...options, deadline }))
    release = dirname(archive.path)
    result = await during("the check for an existing installation", () => existingRuntime(release, archive, deadline, run))
    if (result) { deadline.clear(); return result }
    // Hold the creation itself. An expiry rejects without waiting for the
    // operation, so this promise is the only remaining record of the path.
    created = mkdtemp(join(release, ".runtime-"))
    const staging = await during("private staging creation", () => deadline.run(() => created))
    await during("private staging permissions", () => privateDirectory(staging, deadline, run))
    await during("runtime archive extraction", () => extractRuntime(archive.path, staging, run, deadline))
    const directory = join(staging, "package")
    await during("private package permissions", () => privateDirectory(directory, deadline, run))
    const { lock, manifest, lockSha256 } = await during("the locked input read",
      () => lockedInput(directory, options.version, deadline))
    // The non-special packaged name survives npm/pnpm packing. At the controlled
    // install root npm ci consumes these exact bytes, including under npm 12.
    await during("the frozen lockfile write", async () => {
      const bytes = await deadline.run(() => readFile(join(directory, "runtime/lock.json"), { signal: deadline.signal }))
      await deadline.run(() => writeFile(join(directory, "package-lock.json"), bytes, { mode: 0o600, flag: "wx", signal: deadline.signal }))
      await deadline.run(() => writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, signal: deadline.signal }))
    })
    const cache = join(staging, ".npm-cache")
    const commandOptions = { cwd: directory, deadline, env: { ...process.env, npm_config_cache: cache } }
    // cwd alone does not override an inherited npm prefix or global setting.
    // CLI options also avoid case-sensitive environment collisions on Windows.
    const location = ["--global=false", "--prefix", directory, "--cache", cache]
    await during("npm ci", () => deadline.run(() => run(process.execPath, [npm.entry, "ci", ...location, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], commandOptions)))
    await during("installed file verification", () => verifyInstalledRuntime(directory, lock, deadline))
    // The reviewed runtime's only build hook is node-pty. Do not grant every
    // downloaded package lifecycle execution because one native module needs it.
    if (lock.packages["node_modules/node-pty"]) {
      const nativeOptions = { ...commandOptions, env: nodePtyBuildEnvironment(runtimePlatform(), commandOptions.env) }
      await during("the native terminal module build", () => deadline.run(() => run(process.execPath, [npm.entry, "rebuild", "node-pty", ...location, "--foreground-scripts", "--ignore-scripts=false"], nativeOptions)))
      await during("installed file verification after the native build", () => verifyInstalledRuntime(directory, lock, deadline))
    }
    await during("the native terminal module load", () => verifyNativeRuntime(directory, lock, deadline, run))
    const materializedHash = await during("the materialized lockfile hash",
      () => hashRuntimeFile(join(directory, "package-lock.json"), "sha256", deadline))
    if (materializedHash !== lockSha256) throw new Error("npm changed the frozen runtime lock. Installation was not published")
    const receipt = { format: 1, version: archive.version, sha256: archive.sha256, lockSha256,
      directory: posix.join(staging.split(/[\\/]/).at(-1), "package") }
    const receiptPath = join(staging, "receipt.json")
    await during("the runtime receipt write",
      () => deadline.run(() => writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx", flush: true, signal: deadline.signal })))
    try {
      // Atomic no-replace publication uses the same primitive as the archive.
      // Concurrent installers keep private trees until one verified receipt wins.
      // Hold this promise too: an expiry abandons the link without waiting, and
      // only its outcome says whether a receipt now names this tree.
      published = link(receiptPath, join(release, "runtime.json"))
      await during("runtime receipt publication", () => deadline.run(() => published))
      keep = true
    } catch (error) { if (error.code !== "EEXIST") throw error }
    result = await during("verification of the published installation",
      () => existingRuntime(release, archive, deadline, run))
    if (!result) throw new Error("Verified runtime receipt disappeared before publication completed")
  } catch (error) { failure = error } finally { deadline.clear() }
  if (created && !keep) {
    const cleanup = bootstrapDeadline(cleanupTimeoutMs, `Staging cleanup exceeded ${cleanupTimeoutMs} ms`)
    let staging
    try {
      // Settle both abandoned operations before deciding. A landed receipt
      // names this tree, and removing it would strand an unusable release.
      if (published) keep = await cleanup.run(() => published.then(() => true, () => false))
      if (!keep) {
        staging = await cleanup.run(() => created.catch(() => undefined))
        if (staging) await cleanup.run(() => removeStaging(staging, remove, cleanup))
      }
    } catch (error) {
      failure = new AggregateError(failure ? [failure, error] : [error],
        `${failure?.message ?? error.message}. Unpublished private staging may remain at ${staging ?? `${join(release, ".runtime-")}*`}; no runnable receipt was confirmed`)
    } finally { cleanup.clear() }
  }
  if (failure) throw failure
  return result
}

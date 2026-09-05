import { execFile } from "node:child_process"
import { chmod, link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, posix, win32 } from "node:path"
import { promisify } from "node:util"

import { bootstrapDaemon } from "./bootstrap-daemon.mjs"
import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { pinnedSha256 } from "./bootstrap-plan.mjs"
import { hashRuntimeFile, readRuntimeJson, validateRuntimeLock, verifyInstalledRuntime } from "./runtime-verification.mjs"

const execute = promisify(execFile)
export const minimumBootstrapNpm = "10.0.0"
const timeoutMsDefault = 300_000
const npmRemedy = `Bootstrap requires npm ${minimumBootstrapNpm} or newer bundled with Node. Install a supported Node distribution including npm`

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

async function existingRuntime(release, archive, deadline) {
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
  return { ...archive, runtimePath: directory }
}

export async function installBootstrapDaemon(options) {
  const timeoutMs = options.timeoutMs ?? timeoutMsDefault
  pinnedSha256(options.expectedSha256)
  const deadline = bootstrapDeadline(timeoutMs,
    `Bootstrap exceeded ${timeoutMs} ms, including installation and verification; inspect ${options.destination} before retrying`)
  const run = options.run ?? runBootstrapCommand
  let staging
  let keep = false
  let result
  let failure
  try {
    const npm = await bundledNpm(deadline, run)
    const archive = await bootstrapDaemon({ ...options, deadline })
    const release = dirname(archive.path)
    result = await existingRuntime(release, archive, deadline)
    if (result) { deadline.clear(); return result }
    await deadline.run(async () => { staging = await mkdtemp(join(release, ".runtime-")) })
    await privateDirectory(staging, deadline, run)
    await extractRuntime(archive.path, staging, run, deadline)
    const directory = join(staging, "package")
    await privateDirectory(directory, deadline, run)
    const { lock, manifest, lockSha256 } = await lockedInput(directory, options.version, deadline)
    // The non-special packaged name survives npm/pnpm packing. At the controlled
    // install root npm ci consumes these exact bytes, including under npm 12.
    const bytes = await deadline.run(() => readFile(join(directory, "runtime/lock.json"), { signal: deadline.signal }))
    await deadline.run(() => writeFile(join(directory, "package-lock.json"), bytes, { mode: 0o600, flag: "wx", signal: deadline.signal }))
    await deadline.run(() => writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, signal: deadline.signal }))
    const commandOptions = { cwd: directory, deadline, env: { ...process.env, npm_config_cache: join(staging, ".npm-cache") } }
    await deadline.run(() => run(process.execPath, [npm.entry, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], commandOptions))
    await verifyInstalledRuntime(directory, lock, deadline)
    // The reviewed runtime's only build hook is node-pty. Do not grant every
    // downloaded package lifecycle execution because one native module needs it.
    if (lock.packages["node_modules/node-pty"]) {
      await deadline.run(() => run(process.execPath, [npm.entry, "rebuild", "node-pty", "--foreground-scripts", "--ignore-scripts=false"], commandOptions))
      await verifyInstalledRuntime(directory, lock, deadline)
    }
    const materializedHash = await hashRuntimeFile(join(directory, "package-lock.json"), "sha256", deadline)
    if (materializedHash !== lockSha256) throw new Error("npm changed the frozen runtime lock. Installation was not published")
    const receipt = { format: 1, version: archive.version, sha256: archive.sha256, lockSha256,
      directory: posix.join(staging.split(/[\\/]/).at(-1), "package") }
    const receiptPath = join(staging, "receipt.json")
    await deadline.run(() => writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx", flush: true, signal: deadline.signal }))
    try {
      // Atomic no-replace publication uses the same primitive as the archive.
      // Concurrent installers keep private trees until one verified receipt wins.
      await deadline.run(async () => { await link(receiptPath, join(release, "runtime.json")); keep = true })
    } catch (error) { if (error.code !== "EEXIST") throw error }
    result = await existingRuntime(release, archive, deadline)
    if (!result) throw new Error("Verified runtime receipt disappeared before publication completed")
  } catch (error) { failure = error }
  try {
    if (staging && !keep) await deadline.run(() => rm(staging, { recursive: true, force: true }))
  } catch (cleanup) {
    failure = new AggregateError(failure ? [failure, cleanup] : [cleanup],
      `${failure?.message ?? cleanup.message}. Unpublished private staging may remain at ${staging}; no runnable receipt was confirmed`)
  } finally { deadline.clear() }
  if (failure) throw failure
  return result
}

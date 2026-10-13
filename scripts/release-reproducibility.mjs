import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { pnpmInvocation } from "./package-artifact-command.mjs"
import { publishablePackages } from "./release-packages.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/release.yml"]
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const hex = (value, size) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`, "u").test(value)
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9._-]{1,160}$/u.test(value)
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }

export function releaseArtifactNames(version) {
  requireValue(typeof version === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(version) && version.length < 100, "Invalid release version")
  return [...publishablePackages.flatMap((name) => {
    const stem = `${name.slice(1).replace("/", "-")}-${version}`
    return [`${stem}.tgz`, `${stem}.sbom.json`]
  }), `domovoi-web-${version}.tar.gz`, "SHA256SUMS"].sort()
}

async function bytes(file, deadline, maximum = 64 * 1024 * 1024) {
  const stat = await deadline.run(() => lstat(file))
  requireValue(stat.isFile() && stat.size <= maximum, "Release input must be a bounded regular file")
  const value = await deadline.run(() => readFile(file))
  requireValue(value.length === stat.size && value.length <= maximum, "Release input changed while reading")
  return value
}
const json = async (file, deadline) => JSON.parse(await bytes(file, deadline, 256 * 1024))

function validateInputs(inputs) {
  requireValue(exact(inputs, ["commit", "tree", "version", "files", "toolchain", "environment"])
    && hex(inputs.commit, 40) && hex(inputs.tree, 40), "Invalid source inputs")
  releaseArtifactNames(inputs.version)
  requireValue(Array.isArray(inputs.files) && inputs.files.length === sourceFiles.length
    && inputs.files.every((file, index) => exact(file, ["name", "sha256"]) && file.name === sourceFiles[index] && hex(file.sha256, 64)), "Invalid source input inventory")
  const tool = inputs.toolchain
  requireValue(exact(tool, ["node", "pnpm", "platform", "arch", "versions"])
    && /^\d+\.\d+\.\d+$/u.test(tool.node) && /^\d+\.\d+\.\d+$/u.test(tool.pnpm)
    && identifier(tool.platform) && identifier(tool.arch)
    && tool.versions && typeof tool.versions === "object" && !Array.isArray(tool.versions)
    && Object.keys(tool.versions).length <= 50 && Object.entries(tool.versions).every(([key, value]) => identifier(key) && typeof value === "string" && /^[a-zA-Z0-9._+-]{0,160}$/u.test(value))
    && tool.versions.node === tool.node, "Invalid observed toolchain")
  requireValue(exact(inputs.environment, ["TZ", "LC_ALL", "SOURCE_DATE_EPOCH"])
    && inputs.environment.TZ === "UTC" && inputs.environment.LC_ALL === "C"
    && /^\d{1,12}$/u.test(inputs.environment.SOURCE_DATE_EPOCH), "Invalid build environment")
}

function validateArtifacts(artifacts, version) {
  const names = releaseArtifactNames(version)
  requireValue(Array.isArray(artifacts) && artifacts.length === names.length
    && artifacts.every((file, index) => exact(file, ["name", "sha256", "size"]) && file.name === names[index]
      && hex(file.sha256, 64) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 64 * 1024 * 1024)
    && artifacts.reduce((sum, file) => sum + file.size, 0) <= 256 * 1024 * 1024, "Invalid release artifact inventory")
}

function validateBuild(build) {
  requireValue(exact(build, ["schemaVersion", "inputs", "producer", "artifacts"]) && build.schemaVersion === 1, "Invalid build receipt")
  validateInputs(build.inputs)
  const producer = build.producer
  requireValue(exact(producer, ["kind", "runId", "slot", "workspaceId"])
    && ["github", "local"].includes(producer.kind) && identifier(producer.runId)
    && ["a", "b"].includes(producer.slot) && hex(producer.workspaceId, 64), "Invalid build producer")
  validateArtifacts(build.artifacts, build.inputs.version)
}

function validatePair(builds) {
  requireValue(Array.isArray(builds) && builds.length === 2, "Two build receipts are required")
  builds.forEach(validateBuild)
  const [first, second] = builds
  requireValue(first.producer.slot === "a" && second.producer.slot === "b"
    && first.producer.workspaceId !== second.producer.workspaceId
    && first.producer.kind === second.producer.kind && first.producer.runId === second.producer.runId, "Build producers must be distinct slots of one run")
  requireValue(isDeepStrictEqual(first.inputs, second.inputs), "Independent build inputs or toolchains differ")
  requireValue(isDeepStrictEqual(first.artifacts, second.artifacts), "Independent build artifact digests differ")
}

async function verifyInputs(root, inputs, commit, deadline) {
  requireValue(inputs.commit === commit, "Release identity changed: comparison source commit differs")
  for (const file of inputs.files) requireValue(digest(await bytes(join(root, file.name), deadline)) === file.sha256, "Release source input digest changed")
  const manifest = await json(join(root, "package.json"), deadline)
  requireValue(manifest.packageManager === `pnpm@${inputs.toolchain.pnpm}`, "Release toolchain does not match packageManager")
}

async function readArtifacts(directory, artifacts, deadline) {
  const result = []
  for (const artifact of artifacts) {
    const value = await bytes(join(directory, artifact.name), deadline)
    requireValue(value.length === artifact.size && digest(value) === artifact.sha256, `Release artifact digest differs: ${artifact.name}`)
    result.push(value)
  }
  return result
}

async function bounded(timeoutMs, operation) {
  const deadline = bootstrapDeadline(timeoutMs, "Release reproducibility deadline exceeded")
  try { return await operation(deadline) }
  finally { deadline.clear() }
}

// Evidence is unsigned. Its integrity is checked here, while the trusted build
// workflow supplies the independent producers. It is not a signing authority.
export async function compareReleaseBuilds({ root = process.cwd(), first, second, destination = join(root, "release"), commit = process.env.GITHUB_SHA, timeoutMs = 60_000 }) {
  return bounded(timeoutMs, async (deadline) => {
    requireValue(await deadline.run(() => realpath(first)) !== await deadline.run(() => realpath(second)), "Independent build directories must differ")
    const builds = await Promise.all([first, second].map((directory) => json(join(directory, "build.json"), deadline)))
    validatePair(builds)
    await verifyInputs(root, builds[0].inputs, commit, deadline)
    for (const directory of [first, second]) {
      const entries = await deadline.run(() => readdir(directory))
      requireValue(isDeepStrictEqual(entries.sort(), [...releaseArtifactNames(builds[0].inputs.version), "build.json"].sort()), "Candidate must contain exactly the complete release artifact inventory and receipt")
    }
    const firstBytes = await readArtifacts(first, builds[0].artifacts, deadline)
    const secondBytes = await readArtifacts(second, builds[1].artifacts, deadline)
    requireValue(firstBytes.every((value, index) => value.equals(secondBytes[index])), "Independent build artifact bytes differ")
    const evidence = { schemaVersion: 1, builds, artifacts: builds[0].artifacts }
    // Exclusive creation: a mismatch never edits an existing canonical release.
    await deadline.run(() => mkdir(destination))
    for (const [index, artifact] of evidence.artifacts.entries()) await deadline.run(() => writeFile(join(destination, artifact.name), firstBytes[index], { flag: "wx" }))
    await deadline.run(() => writeFile(join(destination, "reproducibility.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }))
    return evidence
  })
}

export async function verifyReleaseReproducibility({ root = process.cwd(), directory = join(root, "release"), commit = process.env.GITHUB_SHA, version, timeoutMs = 60_000, deadline: outer }) {
  const verify = async (deadline) => {
    const evidence = await json(join(directory, "reproducibility.json"), deadline)
    requireValue(exact(evidence, ["schemaVersion", "builds", "artifacts"]) && evidence.schemaVersion === 1, "Invalid reproducibility evidence")
    validatePair(evidence.builds)
    requireValue(evidence.builds[0].inputs.version === version && isDeepStrictEqual(evidence.artifacts, evidence.builds[0].artifacts), "Reproducibility artifact inventory differs")
    await verifyInputs(root, evidence.builds[0].inputs, commit, deadline)
    await readArtifacts(directory, evidence.artifacts, deadline)
    return evidence
  }
  return outer ? verify(outer) : bounded(timeoutMs, verify)
}

// Release producers run on POSIX runners. A detached group contains only this
// command and its descendants; caches are removable only after it is gone.
export async function runBuildCommand({ root, executable, args, env, deadline, cleanupTimeoutMs = 30_000 }) {
  requireValue(process.platform !== "win32", "Independent release producers require POSIX process groups")
  deadline.check()
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let outputSize = 0
    let failure
    let closed = false
    let finished = false
    let cleanupTimer
    let poll
    const groupExists = () => {
      if (!child.pid) return false
      try { process.kill(-child.pid, 0); return true }
      catch (error) { if (error.code === "ESRCH") return false; throw error }
    }
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(cleanupTimer)
      clearTimeout(poll)
      deadline.signal.removeEventListener("abort", abort)
      if (error) {
        error.command = args[0]
        error.stderr = Buffer.concat(stderr).toString("utf8")
        error.stdout = Buffer.concat(stdout).toString("utf8")
        reject(error)
      }
      else {
        try { deadline.check(); resolveCommand(Buffer.concat(stdout).toString("utf8").trim()) }
        catch (cause) { reject(cause) }
      }
    }
    const stop = (error) => {
      failure ??= error
      if (!cleanupTimer) cleanupTimer = setTimeout(() => {
        const uncertain = new Error("Build command cleanup could not confirm descendant exit", { cause: failure })
        uncertain.unconfirmedChildren = true
        finish(uncertain)
      }, cleanupTimeoutMs)
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL") }
        catch (cause) { if (cause.code !== "ESRCH") failure = cause }
      }
    }
    const checkClosed = () => {
      if (finished || !closed) return
      try {
        if (!groupExists()) { finish(failure); return }
        stop(failure ?? new Error("Build command left running descendants"))
        poll = setTimeout(checkClosed, 10)
      } catch (error) { stop(error); poll = setTimeout(checkClosed, 10) }
    }
    const abort = () => stop(deadline.signal.reason)
    deadline.signal.addEventListener("abort", abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      outputSize += chunk.length
      if (outputSize > 16 * 1024 * 1024) stop(new Error("Build command output limit exceeded"))
      else if (stream === child.stdout) stdout.push(chunk)
      else stderr.push(chunk)
    })
    child.once("error", (error) => { failure = error })
    child.once("close", (code, signal) => {
      closed = true
      if (code !== 0 && !failure) failure = new Error(`Build command failed (${code ?? signal})`)
      checkClosed()
    })
    if (deadline.signal.aborted) abort()
  })
}

const command = (root, executable, args, env, deadline) => runBuildCommand({ root, executable, args, env, deadline })

// Run this module from each fresh checkout. The existing packer intentionally
// resolves its own module checkout, so calling it twice with other roots would
// not constitute two independent builds.
export async function buildReleaseCandidate({ root = repositoryRoot, slot, runId, kind = "local", timeoutMs = 1_200_000 } = {}) {
  return bounded(timeoutMs, async (deadline) => {
    requireValue(process.platform !== "win32", "Independent release producers require POSIX process groups")
    requireValue(await deadline.run(() => realpath(root)) === await deadline.run(() => realpath(repositoryRoot)), "Build must execute from its own checkout")
    requireValue(["a", "b"].includes(slot) && identifier(runId) && ["local", "github"].includes(kind), "Build needs explicit producer identity")
    const git = (args) => command(root, "git", args, process.env, deadline)
    requireValue(await git(["status", "--porcelain", "--untracked-files=all", "--ignored"]) === "", "Build requires a completely clean checkout without dependencies or generated files")
    const commit = await git(["rev-parse", "HEAD"])
    const tree = await git(["rev-parse", "HEAD^{tree}"])
    const epoch = await git(["show", "-s", "--format=%ct", "HEAD"])
    const manifest = await json(join(root, "package.json"), deadline)
    const version = (await json(join(root, "packages/protocol/package.json"), deadline)).version
    const isolation = await mkdtemp(join(tmpdir(), "domovoi-release-build-"))
    // A small allowlist excludes caller auth, renderer injection and inherited
    // compiler/package settings. Each invocation owns its complete cache tree.
    const env = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
    Object.assign(env, { PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`, CI: "true", TZ: "UTC", LC_ALL: "C", SOURCE_DATE_EPOCH: epoch,
      PNPM_HOME: join(isolation, "pnpm-home"), PNPM_CONFIG_STATE_DIR: join(isolation, "state"),
      PNPM_CONFIG_NPMRC_AUTH_FILE: join(isolation, "npmrc"), NPM_CONFIG_USERCONFIG: join(isolation, "npmrc"),
      npm_config_devdir: join(isolation, "node-gyp"),
      XDG_CACHE_HOME: join(isolation, "cache"), XDG_DATA_HOME: join(isolation, "data"), XDG_CONFIG_HOME: join(isolation, "config"),
      PNPM_CONFIG_STORE_DIR: join(isolation, "store"), PNPM_CONFIG_CACHE_DIR: join(isolation, "pnpm-cache"),
      PNPM_CONFIG_SIDE_EFFECTS_CACHE: "false", PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE: "false",
      npm_config_cache: join(isolation, "npm-cache"), ELECTRON_CACHE: join(isolation, "electron-cache") })
    let cleanupSafe = true
    try {
      await deadline.run(() => writeFile(join(isolation, "npmrc"), "", { flag: "wx", mode: 0o600 }))
      const invocation = pnpmInvocation(process.platform, { env })
      const pnpm = (args) => command(root, invocation.command, [...invocation.args, ...args], env, deadline)
      const pnpmVersion = await pnpm(["--version"])
      requireValue(manifest.packageManager === `pnpm@${pnpmVersion}`, "Observed pnpm version must match the exact packageManager pin")
      for (const [key, expected] of Object.entries({ storeDir: env.PNPM_CONFIG_STORE_DIR, cacheDir: env.PNPM_CONFIG_CACHE_DIR,
        stateDir: env.PNPM_CONFIG_STATE_DIR, sideEffectsCache: "false", enableGlobalVirtualStore: "false" })) {
        requireValue(await pnpm(["config", "get", key]) === expected, `pnpm did not apply isolated ${key}`)
      }
      const inputs = { commit, tree, version, files: [], toolchain: { node: process.versions.node, pnpm: pnpmVersion, platform: process.platform, arch: process.arch, versions: { ...process.versions } }, environment: { TZ: env.TZ, LC_ALL: env.LC_ALL, SOURCE_DATE_EPOCH: epoch } }
      for (const name of sourceFiles) inputs.files.push({ name, sha256: digest(await bytes(join(root, name), deadline)) })
      validateInputs(inputs)
      await pnpm(["install", "--frozen-lockfile"])
      requireValue(isDeepStrictEqual(JSON.parse(await pnpm(["exec", "node", "-p", "JSON.stringify(process.versions)"])), inputs.toolchain.versions), "Build Node executable differs from recorded toolchain")
      await pnpm(["release:artifacts"])
      requireValue(await git(["rev-parse", "HEAD"]) === commit && await git(["rev-parse", "HEAD^{tree}"]) === tree, "Build changed the source commit or tree")
      await git(["diff", "--exit-code", commit])
      requireValue(await git(["ls-files", "--others", "--exclude-standard"]) === "", "Build created unexpected source files")
      await verifyInputs(root, inputs, commit, deadline)
      const directory = join(root, "release")
      requireValue(isDeepStrictEqual((await deadline.run(() => readdir(directory))).sort(), releaseArtifactNames(version)), "Builder produced an unexpected release inventory")
      const artifacts = []
      for (const name of releaseArtifactNames(version)) {
        const value = await bytes(join(directory, name), deadline)
        artifacts.push({ name, sha256: digest(value), size: value.length })
      }
      const receipt = { schemaVersion: 1, inputs, producer: { kind, runId, slot, workspaceId: digest(`${await deadline.run(() => realpath(root))}:${randomUUID()}`) }, artifacts }
      validateBuild(receipt)
      await deadline.run(() => writeFile(join(directory, "build.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }))
      return receipt
    } catch (error) {
      if (error.unconfirmedChildren) cleanupSafe = false
      if (!cleanupSafe) throw new Error(`Build failed with unconfirmed descendants; retained isolation at ${isolation}`, { cause: error })
      throw error
    } finally {
      if (cleanupSafe) {
        const cleanup = bootstrapDeadline(30_000, `Build cache cleanup incomplete at ${isolation}`)
        try { await cleanup.run(() => rm(isolation, { recursive: true, force: true })) }
        finally { cleanup.clear() }
      }
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, ...args] = process.argv.slice(2)
    if (operation === "build" && args.length === 2) console.log(JSON.stringify(await buildReleaseCandidate({ slot: args[0], runId: args[1], kind: process.env.GITHUB_ACTIONS === "true" ? "github" : "local" })))
    else if (operation === "compare" && args.length === 2) console.log(JSON.stringify(await compareReleaseBuilds({ first: args[0], second: args[1] })))
    else throw new Error("usage: release-reproducibility.mjs build <a|b> <run-id> | compare <first-directory> <second-directory>")
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

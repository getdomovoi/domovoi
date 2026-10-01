import { execFile, spawn, type ChildProcess, type PromiseWithChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants, promises as fs } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { publishFileDurably } from "@getdomovoi/credential-store"

import { windowsTreeKill, type TaskkillSpawn } from "./claude-process.js"
import { gitCommand } from "./git-command.js"
import { gitEnvironment, inertRepositoryConfig, trustedConfigScopes } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"
import type { GitFilterSetting } from "./repository-git-filters.js"
import { trackRestoreCommand } from "./workspace-restore-lease.js"

const execute = promisify(execFile)

// Runs the Git commands that can start a program (a checkout, staging, a
// status or diff that reads files, a reset) without Git or git-lfs reading
// any of the repository's own config (ruling Q223 for a new session's
// checkout; P8 PR B for checkpoint, snapshot, restore, revert, transfer and
// evidence on an existing session worktree). The repository's config can name
// a program anywhere Git or git-lfs looks: a filter, but also core.sshCommand,
// core.askPass or a credential helper git-lfs starts to fetch an object,
// core.fsmonitor, and whatever else a later version reads. Pinning keys one by
// one cannot keep up, so the commands run in a temporary Git directory of
// their own:
//
// - Its config is Git's global and system config, which Git reads as always,
//   and the values below, passed as command-line config. No repository,
//   worktree or included repository config file is read, by Git or by
//   git-lfs, which reads its config through `git config`.
// - It has no hooks (core.hooksPath points nowhere, and it was made without
//   a template) and core.fsmonitor is off.
// - It uses the repository's own object store (GIT_OBJECT_DIRECTORY): commits
//   and trees are read from it, and a blob staged, or one a partial clone
//   fetches, lands in it.
// - Its HEAD is whatever commit a command is given (`head`), detached: it has
//   no refs of its own, so a command that would move a ref moves nothing of
//   the repository's, and the caller moves the repository's refs itself with
//   plain ref commands, which start no program.
// - Its index is the isolated directory's own (a new session's checkout,
//   copied into the worktree afterwards) or the session worktree's own, read
//   and written in place under Git's usual index lock.
// - Its info/ holds copies of the repository's info/attributes and
//   info/exclude and, when sparse checkout is on, the worktree's
//   sparse-checkout patterns. They are data: attributes can only select a
//   filter driver the isolated config defines, which is the person's own, the
//   exact `git lfs install` line, or a trusted repository's reviewed one.
// - It lives inside the repository's Git directory, so the person's
//   `includeIf "gitdir:..."` conditions match as they do for the repository.
//   It records its owner process first. One an earlier operation left behind
//   is removed, best effort, the next time an isolated Git directory is set
//   up in the same repository (sweepStaleCheckouts), but kept while its owner
//   process is alive, while it holds a .lock, or while it cannot be listed;
//   a kept one with a lock may need removing by hand.
//
// Carried from the repository's config, as values only:
// - The core settings that decide what Git writes or reads as changed
//   (carriedCoreKeys): line endings, symlinks, case and Unicode handling, file
//   modes, NTFS and HFS path protection, long paths, encoding round trips,
//   sparse checkout, the ignore and attribute files it names, stat checks and
//   shared-repository permissions. A path one of them names is read as data.
// - lfs.storage, resolved against the repository's Git directory and
//   defaulting to its lfs/ folder, so git-lfs uses the repository's own store.
// - The exact `git lfs install` lines the repository sets (ruling Q207 A).
// - Each remote's url, pushurl and lfsurl, and lfs.url and lfs.pushurl, when
//   the value is an https, http, ssh or git URL or an scp-like address
//   (carriedRemoteUrl); any other form (ext::, fd::, any <helper>:: address,
//   file://, a local path, a host starting with "-") is dropped, and a remote
//   left with no url is not carried at all (ruling Q224). So git-lfs derives
//   its endpoint from the remote as it normally would, and a partial clone
//   fetches a missing blob from its promisor remote, both with the person's
//   own transport settings. lfs.url and lfs.pushurl are on git-lfs's
//   .lfsconfig safe list and remote.<name>.lfsurl is accepted from it too;
//   no other lfs.<url>.* setting is carried.
// - For a partial clone, extensions.partialClone (written to the isolated
//   config file, where Git reads extensions) with the named remote's promisor
//   and partialclonefilter.
// Under a trusted grant, the reviewed filter definitions are added, as the
// values the grant's digest covers (repository-git-filter-gate.ts).
// Not carried: url.*.insteadOf and pushInsteadOf, every other transport
// setting, and extensions other than the object format and partialClone.
// Transports are limited to https, http, ssh and git (protocol.allow never
// for the rest), at least as strict as Git's defaults.
// The index is written without split index, untracked cache or sparse index:
// their extra files would live in the temporary directory and go with it.
//
// Every command runs in a process group of its own on POSIX, and a cancelled
// one (a timeout, an emergency stop) ends with the whole group, so a filter
// it started, and what that filter started, ends with it (rulings Q102 A and
// Q104 A). Windows has no process groups; there the process tree is ended
// with taskkill (ruling Q103 A).

const carriedCoreKeys = [
  "core.autocrlf", "core.eol", "core.safecrlf", "core.symlinks", "core.ignorecase", "core.precomposeunicode",
  "core.filemode", "core.protectntfs", "core.protecthfs", "core.longpaths", "core.checkroundtripencoding",
  "core.sparsecheckout", "core.sparsecheckoutcone", "core.excludesfile", "core.attributesfile",
  "core.trustctime", "core.checkstat", "core.sharedrepository",
] as const
const carriedPattern = `^(${[...carriedCoreKeys, "lfs.storage", "lfs.url", "lfs.pushurl", "extensions.partialclone"]
  .map((key) => key.replaceAll(".", String.raw`\.`)).join("|")}|remote\\..+\\.(url|pushurl|lfsurl|promisor|partialclonefilter))$`
const allowedProtocols = ["https", "http", "ssh", "git"]
const safeRemoteName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const maximumOutputBytes = 32 * 1024 * 1024

// Inherited variables that would point a command at another directory,
// object store or attribute source than the ones set here.
const droppedEnvironment = [
  "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_ATTR_SOURCE",
  "GIT_ATTR_NOSYSTEM", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_NO_LAZY_FETCH",
  "GIT_PROTOCOL_FROM_USER", "GIT_ALLOW_PROTOCOL",
]

// A checkout directory with no owner file older than this is one a daemon
// that stopped mid checkout left behind before it wrote the file.
export const staleCheckoutAgeMs = 10 * 60 * 1000
// Written into each checkout directory first: {"pid", "startedAt"}.
const checkoutOwnerFile = "domovoi-owner"
const checkoutDirectoryName = /^domovoi-checkout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

// Whether a remote URL is carried into the checkout: an https, http, ssh or
// git URL, or an scp-like [user@]host:path, with no host starting with "-".
export function carriedRemoteUrl(url: string): boolean {
  if (url === "" || /[\p{Cc}\s]/u.test(url)) return false
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?(.)/u.exec(url)
  if (scheme) return allowedProtocols.includes(scheme[1]!.toLowerCase()) && scheme[2] !== "-"
  // <transport>::<address> names a remote helper: ext::, fd:: and any other.
  if (url.includes("::")) return false
  // Git reads host:path as SSH only when the colon comes before any slash.
  const scp = /^(?:[^@/:]+@)?([^/:]+):/u.exec(url)
  return scp !== null && !scp[1]!.startsWith("-") && !/^[A-Za-z]$/u.test(scp[1]!)
}

let gitVersion: Promise<[number, number] | undefined> | undefined

function installedGitVersion(): Promise<[number, number] | undefined> {
  gitVersion ??= (async () => {
    const env = gitEnvironment()
    const { stdout } = await execute(gitCommand(env), ["--version"], { env, encoding: "utf8" })
    const match = /(\d+)\.(\d+)/u.exec(stdout)
    return match ? [Number(match[1]), Number(match[2])] as [number, number] : undefined
  })().catch(() => undefined)
  return gitVersion
}

// Reads from the worktree: `git config` and `git rev-parse` start no program
// the repository's config names.
async function worktreeGit(worktree: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = gitEnvironment()
  return (await execute(gitCommand(env), ["-C", worktree, ...inertRepositoryConfig, ...args], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
  })).stdout
}

// Every carried key's values in Git's order. A key with no value is boolean true.
async function carriedSettings(worktree: string, signal?: AbortSignal): Promise<Array<[string, string]>> {
  let output = ""
  try {
    output = await worktreeGit(worktree, ["config", "-z", "--get-regexp", carriedPattern], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error
  }
  return output.split("\0").filter((record) => record !== "").map((record) => {
    const newline = record.indexOf("\n")
    return newline === -1 ? [record, "true"] : [record.slice(0, newline), record.slice(newline + 1)]
  })
}

// A path rev-parse printed, made absolute; the object format stays a word.
function resolveLine(worktree: string, line: string): string {
  const text = line.trim()
  return text === "" || !/[\\/]/u.test(text) ? text : resolve(worktree, text)
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

// The pid that made a checkout directory, from the owner file written into
// it first, or undefined when the file is absent, a link or unreadable.
async function checkoutOwner(directory: string): Promise<number | undefined> {
  const file = join(directory, checkoutOwnerFile)
  const info = await fs.lstat(file).catch(() => undefined)
  if (!info?.isFile()) return undefined
  try {
    const owner: unknown = JSON.parse(await fs.readFile(file, "utf8"))
    const pid = typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>).pid : undefined
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

// Whether a process with this pid runs on this machine: signal 0 checks and
// sends nothing. EPERM means it runs as someone else.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

// Removes checkout directories an earlier daemon left in this Git directory,
// by their exact name pattern, and never one still in use. A directory whose
// owner file names a process that is gone is removed; one whose owner runs is
// kept however old it is, since a checkout can outlast any age (a longer
// operation timeout, a stalled LFS fetch); one with no readable owner file is
// removed only once it is stale, which also covers a checkout between making
// its directory and writing the file. Links are never followed. Best effort.
async function sweepStaleCheckouts(commonDirectory: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(commonDirectory)
  } catch {
    return
  }
  for (const name of names) {
    if (!checkoutDirectoryName.test(name)) continue
    const path = join(commonDirectory, name)
    const info = await fs.lstat(path).catch(() => undefined)
    if (!info?.isDirectory()) continue
    const owner = await checkoutOwner(path)
    if (owner === undefined ? Date.now() - info.mtimeMs < staleCheckoutAgeMs : processAlive(owner)) continue
    // One holding a lock stays: a killed command leaves its index lock (the
    // isolated index's index.lock, a checkpoint's checkpoint-index.lock), and
    // Domovoi cannot tell no other Git holds it (rulings Q265, Q281). Any
    // name ending .lock counts, so a lock name added later is kept too, and so
    // is a directory that cannot be listed. The daemon owner's exit proves
    // nothing about the processes its commands started.
    const entries = await fs.readdir(path).catch(() => undefined)
    if (entries === undefined || entries.some((name) => name.endsWith(".lock"))) continue
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

export type GitProcessResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string }

function abortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal.reason })
  error.name = "AbortError"
  return error
}

// The Windows stop of one Git command (ruling Q276). taskkill /T ends the
// tree under the PID it is given, and runs only while Git has not been seen
// to exit: Node holds Git's process handle until it reports the exit, so the
// PID cannot belong to another process until then. Once Git has exited, its
// orphaned children are out of reach, and only the bounded teardown settles
// the command, until the Q111 job-object follow-up keeps authority over
// them. A small window remains between this check and taskkill opening the
// PID, should Git exit in it. One taskkill at a time.
//
// Each taskkill has a bound of its own, which holds whether or not the
// command settles first (ruling Q281). Running past it is a failed taskkill
// (ruling Q295): Git, if still running, is killed directly, as for any
// taskkill failure, and taskkill is asked to end. Its completion handlers
// stay, so its real exit, or an error from the kill, is still observed. That
// direct kill reaches Git alone; whether the processes Git started have ended
// stays unknown, as after any kill (workspace-restore-lease.ts).
export function windowsGitStop(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  run: TaskkillSpawn = spawn,
): { stop(): void } {
  let taskkill: ChildProcess | undefined
  const exited = (spawned: Pick<ChildProcess, "exitCode" | "signalCode">) => spawned.exitCode !== null || spawned.signalCode !== null
  return {
    stop() {
      if (child.pid === undefined || exited(child)) return
      if (taskkill !== undefined && !exited(taskkill)) return
      let bound: NodeJS.Timeout | undefined
      const overrun = new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error(`taskkill did not finish within ${gitTeardownTimeoutMs} ms`)), gitTeardownTimeoutMs)
        bound.unref?.()
      })
      const killing = windowsTreeKill(child.pid, (command, args, options) => (taskkill = run(command, args, options)))
      // Settles on its own after an overrun too; nothing waits for it then.
      killing.catch(() => undefined)
      const started = taskkill
      void Promise.race([killing, overrun]).then(() => clearTimeout(bound), () => {
        clearTimeout(bound)
        if (started !== undefined && !exited(started)) {
          try {
            started.kill()
          } catch {
            // Its error event, which windowsTreeKill observes, says so too.
          }
        }
        if (!exited(child)) child.kill("SIGKILL")
      })
    },
  }
}

// How long a stopped command's teardown may take once its group was
// signalled: then its output pipes are destroyed and the command settles as
// stopped, whatever still holds them (ruling Q272).
export const gitTeardownTimeoutMs = 5_000

// Runs one Git command in a process group of its own (POSIX), feeding its
// output to onStdout, which can stop it. A cancelled or stopped command is
// ended with its whole group. Kill authority lasts until the output pipes
// close, not only until Git itself exits: a child Git started can outlive it
// and hold the pipes (ruling Q272). While a process holds them the group id
// is normally still in use, since that process is usually in the group, so
// the signal reaches processes this command started. On Windows the process
// tree is ended instead, and only while Git itself runs (windowsGitStop).
//
// Ending the group does not prove that every process the command started has
// ended: one can leave the group (setsid). So a killed command still leaves
// its descendants unknown to the restore lease (workspace-restore-lease.ts).
export function runGitProcess(args: readonly string[], options: {
  env: NodeJS.ProcessEnv
  cwd: string
  signal?: AbortSignal | undefined
  onStdout?: (chunk: Buffer, stop: () => void) => void
  // Runs once, just before a running command is killed.
  beforeKill?: () => void
}): PromiseWithChild<GitProcessResult> {
  const posix = process.platform !== "win32"
  // An absolute git.exe on Windows, never one in the worktree that is the cwd
  // here (git-command.ts, ruling Q301).
  const child = spawn(gitCommand(options.env), [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: posix,
    windowsHide: true,
  })
  const { signal } = options
  const windows = posix ? undefined : windowsGitStop(child)
  const errors: Buffer[] = []
  let errorBytes = 0
  let settled = false
  let killing = false
  let teardown: NodeJS.Timeout | undefined
  let settle: (outcome: { error: unknown } | { result: GitProcessResult }) => void = () => {}
  const stderrText = () => Buffer.concat(errors).toString("utf8").trim()
  const end = () => {
    if (settled || child.pid === undefined) return
    if (!killing) {
      killing = true
      options.beforeKill?.()
    }
    if (windows !== undefined) {
      windows.stop()
    } else {
      const exited = child.exitCode !== null || child.signalCode !== null
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        if (!exited) child.kill("SIGKILL")
      }
    }
    teardown ??= setTimeout(() => {
      if (settled) return
      child.stdout.destroy()
      child.stderr.destroy()
      settle(signal?.aborted
        ? { error: abortError(signal) }
        : { result: { code: child.exitCode, signal: child.signalCode ?? "SIGKILL", stderr: stderrText() } })
    }, gitTeardownTimeoutMs)
  }
  const promise = new Promise<GitProcessResult>((resolvePromise, reject) => {
    settle = (outcome) => {
      if (settled) return
      settled = true
      if (teardown !== undefined) clearTimeout(teardown)
      signal?.removeEventListener("abort", end)
      if ("error" in outcome) reject(outcome.error)
      else resolvePromise(outcome.result)
    }
    signal?.addEventListener("abort", end, { once: true })
    if (signal?.aborted) end()
    child.stdout.on("data", (chunk: Buffer) => options.onStdout?.(chunk, end))
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 16_384) return
      const captured = chunk.subarray(0, 16_384 - errorBytes)
      errors.push(captured)
      errorBytes += captured.length
    })
    child.once("error", (error) => settle({ error }))
    child.once("close", (code, closeSignal) => {
      settle(signal?.aborted ? { error: abortError(signal) } : { result: { code, signal: closeSignal, stderr: stderrText() } })
    })
  }) as PromiseWithChild<GitProcessResult>
  promise.child = child
  return promise
}

// A Git command that exited with an error, shaped as execFile's are: `code`
// is the exit status, so callers that read exit 1 as "nothing matched" can.
function gitFailure(result: GitProcessResult): Error {
  return Object.assign(new Error(result.stderr || `git exited with ${result.code ?? result.signal ?? "no status"}`), {
    code: result.code ?? undefined,
    signal: result.signal ?? undefined,
    stderr: result.stderr,
  })
}

export type IsolatedGitRun = {
  // An index file other than the one this isolated directory uses.
  index?: string | undefined
  // The command's own signal, or null to run it with none (a cleanup that
  // must still happen after a cancel). The isolated directory's by default.
  signal?: AbortSignal | null | undefined
  // Fetch nothing, not even a promised object a partial clone lacks.
  offline?: boolean | undefined
}

export type IsolatedGit = {
  // The temporary Git directory, and the worktree's own index file.
  readonly gitDirectory: string
  readonly worktreeIndex: string
  // Puts `commit` at the isolated HEAD, detached, for the commands after it:
  // a status or reset compares against it. Commands running meanwhile read
  // either the old HEAD or the new one, never a partial file.
  setHead(commit: string): Promise<void>
  // Runs Git and returns its output untrimmed.
  run(args: readonly string[], options?: IsolatedGitRun): Promise<string>
  // Runs Git, handing its output to onStdout as it arrives.
  stream(args: readonly string[], onStdout: (chunk: Buffer, stop: () => void) => void, options?: IsolatedGitRun): Promise<GitProcessResult>
  // Index locks a killed command left, which Domovoi cannot tell are its own:
  // nothing may rewrite the index under one or remove it (ruling Q265).
  readonly indexLocksLeft: readonly string[]
  dispose(): Promise<void>
}

export async function openIsolatedGit(input: {
  worktree: string
  // The worktree's filter settings as the gate read them: the source of the
  // exact `git lfs install` lines the repository sets.
  settings: readonly GitFilterSetting[]
  // A trusted repository's reviewed filter definitions, as key and value.
  reviewed?: ReadonlyArray<readonly [string, string]> | undefined
  // Read and write the session worktree's own index (an operation on an
  // existing session); otherwise the isolated directory's own.
  worktreeIndex: boolean
  // Runs before every command and throws to stop it: trust lapsed since the
  // gate that allowed the reviewed definitions.
  beforeCommand?: (() => void) | undefined
  signal?: AbortSignal | undefined
}): Promise<IsolatedGit> {
  const { worktree, settings, signal } = input
  // One rev-parse answers each on its own line, in the order asked.
  const [commonDirectory, infoAttributes, infoExclude, sparseCheckout, index, objectFormat] = (await worktreeGit(worktree, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
    "--git-path", "info/attributes", "--git-path", "info/exclude", "--git-path", "info/sparse-checkout",
    "--git-path", "index", "--show-object-format",
  ], signal)).split("\n").map((line) => resolveLine(worktree, line))
  if (!commonDirectory || !infoAttributes || !infoExclude || !sparseCheckout || !index || !objectFormat) {
    throw new Error("Git did not name the worktree's directories")
  }
  const carried = await carriedSettings(worktree, signal)
  const last = (key: string) => carried.filter(([name]) => name === key).at(-1)?.[1]

  const pins: Array<readonly [string, string]> = []
  for (const key of carriedCoreKeys) {
    const value = last(key)
    if (value !== undefined) pins.push([key, value])
  }
  const storage = last("lfs.storage")
  pins.push(["lfs.storage", storage === undefined || storage === "" ? join(commonDirectory, "lfs") : isAbsolute(storage) ? storage : resolve(commonDirectory, storage)])
  for (const setting of settings) {
    if (!trustedConfigScopes.has(setting.scope) && isStandardLfsFilterLine(setting.key, setting.value)) pins.push([setting.key, setting.value])
  }
  for (const key of ["lfs.url", "lfs.pushurl"]) {
    const value = last(key)
    if (value !== undefined && carriedRemoteUrl(value)) pins.push([key, value])
  }

  // Remotes, by name, with only the values carried.
  const remotes = new Map<string, Array<[string, string]>>()
  const hasUrl = new Set<string>()
  for (const [key, value] of carried) {
    if (!key.startsWith("remote.")) continue
    const variable = key.slice(key.lastIndexOf(".") + 1)
    const name = key.slice("remote.".length, key.lastIndexOf("."))
    if (!safeRemoteName.test(name)) continue
    const values = remotes.get(name) ?? []
    if (variable === "url" || variable === "pushurl" || variable === "lfsurl") {
      if (!carriedRemoteUrl(value)) continue
      if (variable === "url") hasUrl.add(name)
    } else if (/[\p{Cc}]/u.test(value)) {
      continue
    }
    values.push([key, value])
    remotes.set(name, values)
  }
  for (const [name, values] of remotes) {
    if (hasUrl.has(name)) pins.push(...values)
  }
  const partialClone = last("extensions.partialclone")
  const promisor = partialClone !== undefined && hasUrl.has(partialClone) ? partialClone : undefined

  pins.push(["protocol.allow", "never"], ...allowedProtocols.map((protocol): [string, string] => [`protocol.${protocol}.allow`, "always"]))
  pins.push(["core.splitindex", "false"], ["core.untrackedcache", "false"], ["index.sparse", "false"])
  pins.push(...input.reviewed ?? [])

  await sweepStaleCheckouts(commonDirectory)
  const gitDirectory = join(commonDirectory, `domovoi-checkout-${randomUUID()}`)
  try {
    // The owner file comes first, so a sweep in another checkout sees this
    // directory as in use for as long as this process runs.
    await fs.mkdir(gitDirectory)
    await fs.writeFile(join(gitDirectory, checkoutOwnerFile), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    await fs.mkdir(join(gitDirectory, "objects"), { recursive: true })
    await fs.mkdir(join(gitDirectory, "refs", "heads"), { recursive: true })
    await fs.mkdir(join(gitDirectory, "info"), { recursive: true })
    await fs.writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/domovoi-checkout\n")
    // Git reads extensions only from the repository's config file. The
    // remote name was checked against safeRemoteName, so it is written as is.
    const extensions = [
      ...(objectFormat === "sha1" ? [] : [`\tobjectformat = ${objectFormat}\n`]),
      ...(promisor === undefined ? [] : [`\tpartialclone = ${promisor}\n`]),
    ]
    await fs.writeFile(join(gitDirectory, "config"), extensions.length === 0
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"
      : `[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n${extensions.join("")}`)
    await copyIfPresent(infoAttributes, join(gitDirectory, "info", "attributes"))
    await copyIfPresent(infoExclude, join(gitDirectory, "info", "exclude"))
    if (last("core.sparsecheckout") === "true") await copyIfPresent(sparseCheckout, join(gitDirectory, "info", "sparse-checkout"))
  } catch (error) {
    await fs.rm(gitDirectory, { recursive: true, force: true })
    throw error
  }

  const environment: NodeJS.ProcessEnv = gitEnvironment()
  for (const name of droppedEnvironment) delete environment[name]
  environment.GIT_DIR = gitDirectory
  environment.GIT_WORK_TREE = worktree
  environment.GIT_OBJECT_DIRECTORY = join(commonDirectory, "objects")
  if (input.worktreeIndex) environment.GIT_INDEX_FILE = index
  pins.forEach(([key, value], position) => {
    environment[`GIT_CONFIG_KEY_${position}`] = key
    environment[`GIT_CONFIG_VALUE_${position}`] = value
  })
  environment.GIT_CONFIG_COUNT = String(pins.length)

  // An offline command fetches nothing: a promised object a partial clone
  // lacks fails the command instead of being fetched, and no transport is
  // allowed, the pins after the carried ones overriding them.
  const offline = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const offlinePins: Array<readonly [string, string]> = [["protocol.allow", "never"], ...allowedProtocols.map((protocol) => [`protocol.${protocol}.allow`, "never"] as const)]
    const next: NodeJS.ProcessEnv = { ...env, GIT_NO_LAZY_FETCH: "1" }
    offlinePins.forEach(([key, value], position) => {
      next[`GIT_CONFIG_KEY_${pins.length + position}`] = key
      next[`GIT_CONFIG_VALUE_${pins.length + position}`] = value
    })
    next.GIT_CONFIG_COUNT = String(pins.length + offlinePins.length)
    return next
  }

  const indexLocksLeft: string[] = []
  const insideGitDirectory = (path: string) => {
    const inside = relative(gitDirectory, path)
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
  }

  const launch = async (args: readonly string[], options: IsolatedGitRun, onStdout: (chunk: Buffer, stop: () => void) => void) => {
    input.beforeCommand?.()
    const commandSignal = options.signal === null ? undefined : options.signal ?? signal
    commandSignal?.throwIfAborted()
    const indexed = options.index === undefined ? environment : { ...environment, GIT_INDEX_FILE: options.index }
    const env = options.offline === true ? offline(indexed) : indexed
    // Git killed while it holds the index lock cannot remove it, and Domovoi
    // cannot tell that a lock found afterwards is that Git's: another Git can
    // have taken the path over in the meantime (ruling Q255). So once the
    // killed Git has been reaped, a lock that is there stays there, the
    // command fails, and the error names the lock for the person to remove.
    // The lock is listed in indexLocksLeft, so the caller neither rewrites the
    // index under it nor removes it (ruling Q265), and dispose keeps this
    // directory when the lock is in it.
    const lock = `${options.index ?? (input.worktreeIndex ? index : join(gitDirectory, "index"))}.lock`
    let killed = false
    const beforeKill = () => { killed = true }
    const lockLeft = async (): Promise<string | undefined> => {
      const present = await fs.lstat(lock).then(() => true, () => false)
      if (!present) return undefined
      if (!indexLocksLeft.includes(lock)) indexLocksLeft.push(lock)
      return `Git's index lock at ${lock} remains after Domovoi stopped Git. Remove it once no Git command is running in this worktree.`
        + (insideGitDirectory(lock) ? ` Domovoi left the temporary Git directory ${gitDirectory} in place with it.` : "")
    }
    let result: GitProcessResult
    try {
      result = await trackRestoreCommand(() => runGitProcess([...inertRepositoryConfig, ...args], { env, cwd: worktree, signal: commandSignal, onStdout, beforeKill }))
    } catch (error) {
      if (killed || commandSignal?.aborted === true) {
        const left = await lockLeft()
        if (left !== undefined && error instanceof Error) error.message = `${error.message}. ${left}`
      }
      throw error
    }
    if (killed) {
      const left = await lockLeft()
      if (left !== undefined) throw new Error(left)
    }
    return result
  }

  return {
    gitDirectory,
    worktreeIndex: index,
    async setHead(commit) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) throw new Error("A detached HEAD names a commit")
      const staged = join(gitDirectory, `HEAD.domovoi-${randomUUID()}`)
      await fs.writeFile(staged, `${commit}\n`)
      await fs.rename(staged, join(gitDirectory, "HEAD"))
    },
    async run(args, options = {}) {
      const chunks: Buffer[] = []
      let size = 0
      let overflowed = false
      const result = await launch(args, options, (chunk, stop) => {
        size += chunk.length
        if (size > maximumOutputBytes) {
          overflowed = true
          stop()
          return
        }
        chunks.push(chunk)
      })
      if (overflowed) throw Object.assign(new Error("Git printed more than Domovoi reads"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
      if (result.code !== 0) throw gitFailure(result)
      return Buffer.concat(chunks).toString("utf8")
    },
    stream: (args, onStdout, options = {}) => launch(args, options, onStdout),
    indexLocksLeft,
    // A directory holding a lock whose owner is unknown stays, lock and all.
    dispose: async () => {
      if (indexLocksLeft.some(insideGitDirectory)) return
      await fs.rm(gitDirectory, { recursive: true, force: true })
    },
  }
}

// An index Domovoi left as it found it, and the worktree with it, for
// recovery. A cleanup that fails afterwards (its own lock's removal not
// flushed, its isolated directory not removed) is noted here and does not
// replace the decision to keep (ruling Q295).
export class IndexKeptError extends Error {
  readonly cleanupFailures: unknown[] = []

  noteCleanupFailure(failure: unknown): void {
    this.cleanupFailures.push(failure)
    this.message = `${this.message}. Cleanup afterwards also failed: ${failure instanceof Error ? failure.message : String(failure)}`
  }
}

// An index lock that was there before Domovoi went to write the index: its
// owner is unknown, so neither the lock nor the index under it is touched.
export class IndexLockHeldError extends IndexKeptError {
  constructor(readonly lock: string) {
    super(`Git's index lock at ${lock} was already there, so Domovoi left the index as it was. Remove the lock once no Git command is running in this worktree`)
    this.name = "IndexLockHeldError"
  }
}

// An index file's bytes, or undefined when there is none.
export async function readIndexFile(path: string): Promise<Buffer | undefined> {
  return fs.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

// An index another Git wrote after Domovoi read it, and before Domovoi went to
// write it: that Git's index is kept as it is.
export class IndexChangedError extends IndexKeptError {
  constructor(readonly path: string) {
    super(`The index at ${path} changed since the worktree was added, so Domovoi left it as another Git wrote it`)
    this.name = "IndexChangedError"
  }
}

// Writes `bytes` over `path` the way Git writes an index: into `path`.lock,
// created exclusively, synced, then renamed over the file (ruling Q276).
// `proceed` runs once the lock is held, while no Git can write the file, and
// returns false to leave everything as it was. A lock already there, whoever
// left it, is never touched ("locked"). A lock this function made and could
// not remove is named in the error, beside whatever failed first. On POSIX
// the rename is synced through its directory; Windows gives no such promise
// for a rename (publishFileDurably).
//
// Once the rename is done the lock's name is no longer this function's:
// another Git can take it at once, so it is never removed after that, and a
// failure then (the directory flush) is an index published with its
// durability unconfirmed (ruling Q281). The publish step itself says when the
// rename is done (ruling Q295); the file now at the index path proves
// nothing, since another Git can replace it at once. Only when the rename is
// known not to have happened is the lock still this function's: it is
// removed and the directory flushed, so a power loss cannot bring it back.
export async function publishUnderIndexLock(
  path: string,
  bytes: () => Promise<Buffer>,
  proceed: () => Promise<boolean> = async () => true,
  io: { publish?: typeof publishFileDurably; syncDirectory?: (directory: string) => Promise<void> } = {},
): Promise<"published" | "locked" | "declined"> {
  const publish = io.publish ?? publishFileDurably
  const flush = io.syncDirectory ?? syncDirectory
  const lock = `${path}.lock`
  let handle: fs.FileHandle
  try {
    handle = await fs.open(lock, "wx")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "locked"
    throw error
  }
  let renamed = false
  let declined = false
  let failure: { error: unknown } | undefined
  try {
    if (await proceed()) {
      await handle.writeFile(await bytes())
      await handle.sync()
      await handle.close()
      await publish(lock, path, () => { renamed = true })
    } else {
      declined = true
    }
  } catch (error) {
    failure = { error }
  } finally {
    await handle.close().catch(() => undefined)
  }
  if (renamed) {
    if (failure === undefined) return "published"
    throw new IndexPublishedNotDurableError(path, failure.error)
  }
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)
  const removed = await fs.unlink(lock).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT")
  if (!removed) {
    const left = `Domovoi could not remove its own index lock at ${lock}. Remove it once no Git command is running in this worktree.`
    throw new IndexLockCleanupError(declined, failure === undefined ? [] : [failure.error], failure === undefined ? left : `${message(failure.error)}. ${left}`)
  }
  try {
    await flush(dirname(lock))
  } catch (error) {
    const unflushed = `Removing its own index lock at ${lock} was not flushed: ${message(error)}`
    throw new IndexLockCleanupError(declined, failure === undefined ? [error] : [failure.error, error],
      failure === undefined ? unflushed : `${message(failure.error)}. ${unflushed}`, error)
  }
  if (failure !== undefined) throw failure.error
  return declined ? "declined" : "published"
}

// Removing this function's own lock, after it declined or failed before the
// rename, did not finish. `declined` keeps the caller's decision: the check
// under the lock found the index changed, and nothing was written (ruling
// Q295).
export class IndexLockCleanupError extends AggregateError {
  constructor(readonly declined: boolean, errors: unknown[], message: string, cause?: unknown) {
    super(errors, message, cause === undefined ? undefined : { cause })
    this.name = "IndexLockCleanupError"
  }
}

// The index is in place, but flushing its directory failed: a power loss
// could still bring the old one back. Nothing is undone.
export class IndexPublishedNotDurableError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`Domovoi published the index at ${path}, but could not confirm it is durable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = "IndexPublishedNotDurableError"
  }
}

// Flushes a directory, so a rename or removal in it survives a power loss.
// Windows gives no such call; there it does nothing (as publishFileDurably).
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// Checks a new session worktree out of `commit` in an isolated Git directory
// and makes the result the new worktree's own index (ruling Q223).
export async function checkOutIsolated(input: {
  worktree: string
  commit: string
  // The new worktree's filter settings as the scan read them.
  settings: readonly GitFilterSetting[]
  reviewed?: ReadonlyArray<readonly [string, string]> | undefined
  beforeCommand?: (() => void) | undefined
  signal?: AbortSignal | undefined
  // The new worktree's index file as it was when the worktree was added
  // (undefined: none). The checkout publishes only over that same file.
  initialIndex: Buffer | undefined
  // The index publish's file steps; a test seam.
  indexIo?: Parameters<typeof publishUnderIndexLock>[3]
}): Promise<void> {
  const { commit, initialIndex } = input
  const isolated = await openIsolatedGit({ ...input, worktreeIndex: false })
  let outcome: { error: unknown } | undefined
  try {
    const version = await installedGitVersion()
    // Git 2.40 and later read in-tree attributes from the commit alone, not a
    // .gitattributes planted in the new worktree before the checkout. Older Git
    // falls back to such a file, which can still only select a driver the
    // isolated config defines.
    const attributeSource = version !== undefined && (version[0] > 2 || (version[0] === 2 && version[1] >= 40)) ? [`--attr-source=${commit}`] : []
    await isolated.run([...attributeSource, "read-tree", "--reset", "-u", commit])
    // The index names the files just written with their stat data, so the new
    // worktree reads as clean without hashing, and filtering, them again. It
    // is written as Git writes one, under the worktree's index.lock created
    // exclusively; a lock already there refuses, the index as it was. Under
    // the lock the index must still be the file it was when the worktree was
    // added, byte for byte: another Git that wrote it since, and finished,
    // holds no lock, and its index is kept (ruling Q281).
    let published: Awaited<ReturnType<typeof publishUnderIndexLock>>
    try {
      published = await publishUnderIndexLock(isolated.worktreeIndex, () => fs.readFile(join(isolated.gitDirectory, "index")), async () => {
        const now = await readIndexFile(isolated.worktreeIndex)
        return now === undefined || initialIndex === undefined ? now === initialIndex : now.equals(initialIndex)
      }, input.indexIo)
    } catch (error) {
      if (!(error instanceof IndexLockCleanupError) || !error.declined) throw error
      const changed = new IndexChangedError(isolated.worktreeIndex)
      changed.noteCleanupFailure(error)
      throw changed
    }
    if (published === "locked") throw new IndexLockHeldError(`${isolated.worktreeIndex}.lock`)
    if (published === "declined") throw new IndexChangedError(isolated.worktreeIndex)
  } catch (error) {
    outcome = { error }
  }
  // A failure to remove the isolated directory never replaces the outcome
  // above: the caller decides from it whether the worktree is kept. One that
  // keeps it notes the failure (ruling Q295); for any other outcome the
  // directory is left for the stale sweep, best effort, at the next isolated
  // Git setup (see the note at the top of this file).
  try {
    await isolated.dispose()
  } catch (error) {
    if (outcome === undefined) throw error
    if (outcome.error instanceof IndexKeptError) {
      outcome.error.noteCleanupFailure(new Error(`Domovoi could not remove its temporary Git directory ${isolated.gitDirectory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (outcome !== undefined) throw outcome.error
}

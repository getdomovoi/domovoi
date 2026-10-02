import { execFile, spawn, type ChildProcess, type PromiseWithChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants, promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { publishFileDurably } from "@getdomovoi/credential-store"

import { windowsTreeKill, type TaskkillSpawn } from "./claude-process.js"
import { gitCommand } from "./git-command.js"
import { gitEnvironment, inertRepositoryConfig, trustedConfigScopes } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"
import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"
import {
  classify, filterKeyPattern, filterSettingKey, lfsPolicyGroup, refuseFilterSettingGitStopsOn, refuseUnmodelledLfsTransferKey,
  RepositoryGitConfigUnreadableError,
} from "./repository-git-filters.js"
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
// - Its config is a snapshot of the person's global and system config as the
//   worktree reads it, taken once as the directory opens, and the values
//   below, passed as command-line config (ruling Q319). The snapshot is
//   written with includes already followed in the worktree's own context (its
//   Git directory and branch) and no include line, to a private directory
//   outside the repository, and is the only global config (GIT_CONFIG_GLOBAL,
//   GIT_CONFIG_NOSYSTEM): no live global, system or included file is read,
//   so a file edited afterwards changes nothing here. Every filter policy key
//   is in it once, at the worktree's effective value. No repository, worktree
//   or included repository config file is read, by Git or by git-lfs, which
//   reads its config through `git config`.
//   Known limit (ruling Q63): a process of the same user can write the
//   snapshot or this directory while an operation runs; that needs write
//   access the person already has, and is not defended against here.
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
// - It lives inside the repository's Git directory, beside the repository's
//   own data. It records its owner process first. One an earlier operation left behind
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

// The filter configuration this directory runs with: the source worktree's
// own, never one it works out again (ruling Q318). Its global and system
// config can be conditional on the Git directory or the branch, which differ
// here, and it reads none of the repository's config. So for every filter
// driver that the source sets any of clean, smudge, process or required for,
// in any scope, each of the four the source sets is pinned to the source's
// effective value, the last one Git reads there (ruling Q317's empty
// override among them).
//
// A command the repository's own config sets, other than the exact `git lfs
// install` lines, runs only as reviewed: under a trusted grant whose reviewed
// definitions hold exactly that key and the worktree's effective value. A
// reviewed value is never pinned itself, so a later override the worktree
// reads, an empty one included, wins (ruling Q319). Otherwise (evidence with
// filters off, or a reviewed value the worktree no longer reads) its driver
// is pinned absent, no command and not required.
function sourceFilterPins(
  entries: readonly ConfigEntry[],
  reviewed: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  const effective = new Map<string, { scope: string; key: string; value: string }>()
  const drivers = new Set<string>()
  for (const entry of entries) {
    const match = filterPolicyKey.exec(entry.key)
    if (match === null) continue
    // A required written alone is true; a command with no value was refused.
    effective.set(entry.key, { scope: entry.scope, key: entry.key, value: entry.value ?? "true" })
    drivers.add(match[1]!)
  }
  // A reviewed definition confirms a value, never supplies one: it counts
  // only where it is exactly the worktree's effective value (ruling Q319).
  const confirmed = new Set(reviewed.map(([key, value]) => `${key}\0${value}`))
  const pins: Array<readonly [string, string]> = []
  for (const driver of drivers) {
    const commands = ["clean", "smudge", "process"].map((operation) => `filter.${driver}.${operation}`)
    const unconfirmed = commands.find((key) => {
      const setting = effective.get(key)
      return setting !== undefined && !trustedConfigScopes.has(setting.scope) && setting.value !== ""
        && !isStandardLfsFilterLine(key, setting.value) && !confirmed.has(`${key}\0${setting.value}`)
    })
    const heldBack = unconfirmed !== undefined
    refuseChangedReview(driverKeys(driver), heldBack ? unconfirmed : undefined, reviewed)
    // Only the keys the source sets: an unset key and an empty one differ to
    // Git (an empty process, unlike none, turns clean and smudge off), so an
    // unset key stays unset, and refuseUnpinnedFilters refuses one this
    // directory would read.
    for (const key of commands) {
      const setting = effective.get(key)
      if (setting !== undefined) pins.push([key, heldBack ? "" : setting.value])
    }
    const required = effective.get(`filter.${driver}.required`)
    if (required !== undefined) pins.push([required.key, heldBack ? "false" : required.value])
  }
  return pins
}

// A filter driver's keys that decide what runs and whether it may fail.
const filterPolicyKey = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u

const driverKeys = (driver: string) => ["clean", "smudge", "process", "required"].map((variable) => `filter.${driver}.${variable}`)

// A driver or Git LFS group the gate allowed under a reviewed definition,
// whose value the worktree no longer reads as reviewed (its config changed
// after the gate): the operation refuses rather than run without it or with
// the new value (rulings Q318, Q319). `unconfirmed` is the key that differs,
// undefined when the group runs as reviewed.
function refuseChangedReview(keys: readonly string[], unconfirmed: string | undefined, reviewed: ReadonlyArray<readonly [string, string]>): void {
  if (unconfirmed === undefined) return
  if (!reviewed.some(([key]) => keys.includes(key))) return
  throw new RepositoryGitConfigUnreadableError("git-failed", {
    detail: `${shownFilterKey(unconfirmed)} changed after the repository's filters were checked; check the repository again`,
  })
}

// The Git LFS policy the isolated directory runs with (ruling Q319): every
// such key the worktree sets, in any scope, once, at its effective value, an
// empty override included. A group whose program the repository's own config
// names (classify), nonempty, is held back, left out whole, unless the
// reviewed definitions hold that exact key and value.
function sourceLfsPolicy(
  entries: readonly ConfigEntry[],
  reviewed: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  const effective = new Map<string, { scope: string; value: string }>()
  for (const entry of entries) {
    if (lfsPolicyGroup(entry.key) !== undefined) effective.set(entry.key, { scope: entry.scope, value: entry.value ?? "true" })
  }
  const confirmed = new Set(reviewed.map(([key, value]) => `${key}\0${value}`))
  const heldBack = new Set<string>()
  for (const [key, { scope, value }] of effective) {
    if (!trustedConfigScopes.has(scope) && value !== "" && classify(key, value) !== undefined && !confirmed.has(`${key}\0${value}`)) {
      const group = lfsPolicyGroup(key)!
      heldBack.add(group)
      refuseChangedReview(reviewed.map(([reviewedKey]) => reviewedKey).filter((reviewedKey) => lfsPolicyGroup(reviewedKey) === group), key, reviewed)
    }
  }
  return [...effective].filter(([key]) => !heldBack.has(lfsPolicyGroup(key)!)).map(([key, { value }]) => [key, value] as const)
}

// After the pins, the directory must read exactly them for every filter
// policy key: a driver or key only this directory sees (a global include
// conditional on its Git directory, say) or a value other than the pin
// refuses, naming the key (ruling Q318). Nothing has run yet.
async function refuseUnpinnedFilters(environment: NodeJS.ProcessEnv, worktree: string, pins: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const policyKey = (key: string) => filterPolicyKey.test(key) || lfsPolicyGroup(key) !== undefined
  const pinned = new Map(pins.filter(([key]) => policyKey(key)))
  let output = ""
  try {
    output = (await execute(gitCommand(environment), [...inertRepositoryConfig, "config", "-z", "--get-regexp", filterKeyPattern], {
      env: environment, cwd: worktree, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    })).stdout
  } catch (error) {
    // Exit 1: no filter key at all, which only holds with nothing pinned.
    if ((error as { code?: unknown }).code !== 1) throw new RepositoryGitConfigUnreadableError("git-failed", { cause: error })
  }
  const seen = new Map<string, string>()
  for (const record of output.split("\0")) {
    if (record === "") continue
    const newline = record.indexOf("\n")
    const key = newline === -1 ? record : record.slice(0, newline)
    refuseUnmodelledLfsTransferKey(key, "the isolated Git directory's config")
    if (!policyKey(key)) continue
    if (newline === -1 && filterPolicyKey.test(key) && !key.endsWith(".required")) {
      throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `the isolated Git directory reads ${shownFilterKey(key)} with no value` })
    }
    seen.set(key, newline === -1 ? "true" : record.slice(newline + 1))
  }
  for (const [key, value] of seen) {
    if (pinned.get(key) !== value) {
      throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `the isolated Git directory reads ${shownFilterKey(key)} other than the worktree does` })
    }
  }
  for (const key of pinned.keys()) {
    if (!seen.has(key)) throw new RepositoryGitConfigUnreadableError("git-failed", { detail: `the isolated Git directory does not read ${shownFilterKey(key)} as the worktree does` })
  }
}

const shownFilterKey = (key: string) => redactInventoryText(key, inventoryFieldCaps.detail)

// One config entry as Git lists it in the worktree: its scope, its key, and
// its value, undefined for a key written with no value.
type ConfigEntry = { scope: string; key: string; value: string | undefined }

// The worktree's whole config as ordinary Git there reads it, in Git's order,
// includes and conditional includes followed in the worktree's own context
// (its Git directory, its branch). Read once per isolated directory: every
// value the directory runs with comes from this one read (ruling Q319).
async function worktreeConfig(worktree: string, signal?: AbortSignal): Promise<ConfigEntry[]> {
  let output = ""
  try {
    output = await worktreeGit(worktree, ["config", "--list", "--show-scope", "-z"], signal)
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as { code?: unknown }).code !== 1) throw new RepositoryGitConfigUnreadableError("git-failed", { cause: error })
  }
  const fields = output.split("\0")
  const entries: ConfigEntry[] = []
  // Each entry is scope NUL key, then LF value when it has one, NUL.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]!
    const record = fields[index + 1]!
    const newline = record.indexOf("\n")
    const key = newline === -1 ? record : record.slice(0, newline)
    const value = newline === -1 ? undefined : record.slice(newline + 1)
    if (filterSettingKey(key)) refuseFilterSettingGitStopsOn(scope, key, value)
    entries.push({ scope, key, value })
  }
  return entries
}

// A config file that Git reads as `entries`, in order: each entry under a
// section header of its own, every subsection and value quoted and escaped.
function configFileText(entries: readonly { key: string; value: string | undefined }[]): string {
  const quoted = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\b", "\\b")}"`
  return entries.map(({ key, value }) => {
    const first = key.indexOf(".")
    const last = key.lastIndexOf(".")
    const section = key.slice(0, first)
    const header = first === last
      ? `[${section}]`
      : `[${section} "${key.slice(first + 1, last).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"]`
    const variable = key.slice(last + 1)
    return `${header}\n\t${variable}${value === undefined ? "" : ` = ${quoted(value)}`}\n`
  }).join("")
}

// Writes the snapshot the isolated directory reads as its only global config
// (GIT_CONFIG_GLOBAL, with GIT_CONFIG_NOSYSTEM), in a private directory of
// its own outside the repository, then reads it back through Git: a file Git
// would read any other way refuses. No include line is written, so nothing
// live is read through it.
async function writeConfigSnapshot(entries: readonly { key: string; value: string | undefined }[]): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(join(tmpdir(), "domovoi-git-config-"))
  try {
    const file = join(directory, "config")
    await fs.writeFile(file, configFileText(entries), { mode: 0o600, flag: "wx" })
    const env = gitEnvironment()
    let output = ""
    try {
      output = (await execute(gitCommand(env), ["config", "--file", file, "--list", "-z"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1 || entries.length > 0) throw error
    }
    const read = output.split("\0").filter((record) => record !== "").map((record) => {
      const newline = record.indexOf("\n")
      return newline === -1 ? { key: record, value: undefined } : { key: record.slice(0, newline), value: record.slice(newline + 1) }
    })
    if (JSON.stringify(read) !== JSON.stringify(entries.map(({ key, value }) => ({ key, value })))) {
      throw new RepositoryGitConfigUnreadableError("git-failed", { detail: "Domovoi could not write a copy of the Git config that Git reads the same way" })
    }
    return { directory, file }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

// The snapshot reaches Git as GIT_CONFIG_GLOBAL, which came in Git 2.32. An
// older Git ignores it and reads the person's live global config and its
// includes in every isolated command, so isolation refuses there, with no
// fallback (ruling Q320). The version is read once per Git binary.
export class GitTooOldForIsolationError extends Error {
  constructor(readonly found: string | undefined) {
    super(`Domovoi needs Git 2.32 or newer for this operation; ${found === undefined ? "it could not read the installed Git's version" : `it found Git ${found}`}. Update Git, then try again.`)
    this.name = "GitTooOldForIsolationError"
  }
}

const isolationGitVersions = new Map<string, Promise<string | undefined>>()

function gitVersionOf(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let version = isolationGitVersions.get(command)
  if (version === undefined) {
    version = execute(command, ["--version"], { env, encoding: "utf8" }).then(({ stdout }) => stdout.trim(), () => undefined)
    isolationGitVersions.set(command, version)
  }
  return version
}

async function refuseGitTooOldForIsolation(read?: () => Promise<string | undefined>): Promise<void> {
  const env = gitEnvironment()
  const text = await (read ?? (() => gitVersionOf(gitCommand(env), env)))()
  const match = text === undefined ? null : /^git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(text)
  if (match === null) throw new GitTooOldForIsolationError(undefined)
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 2 || (major === 2 && minor < 32)) throw new GitTooOldForIsolationError(match[3] === undefined ? `${major}.${minor}` : `${major}.${minor}.${match[3]}`)
}

export async function openIsolatedGit(input: {
  worktree: string
  // A trusted repository's reviewed filter definitions, as key and value.
  reviewed?: ReadonlyArray<readonly [string, string]> | undefined
  // Read and write the session worktree's own index (an operation on an
  // existing session); otherwise the isolated directory's own.
  worktreeIndex: boolean
  // Runs before every command and throws to stop it: trust lapsed since the
  // gate that allowed the reviewed definitions.
  beforeCommand?: (() => void) | undefined
  signal?: AbortSignal | undefined
  // `git --version` of the Git isolation runs; a test seam.
  gitVersion?: (() => Promise<string | undefined>) | undefined
}): Promise<IsolatedGit> {
  const { worktree, signal } = input
  await refuseGitTooOldForIsolation(input.gitVersion)
  // One rev-parse answers each on its own line, in the order asked.
  const [commonDirectory, infoAttributes, infoExclude, sparseCheckout, index, objectFormat] = (await worktreeGit(worktree, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
    "--git-path", "info/attributes", "--git-path", "info/exclude", "--git-path", "info/sparse-checkout",
    "--git-path", "index", "--show-object-format",
  ], signal)).split("\n").map((line) => resolveLine(worktree, line))
  if (!commonDirectory || !infoAttributes || !infoExclude || !sparseCheckout || !index || !objectFormat) {
    throw new Error("Git did not name the worktree's directories")
  }
  // Everything below comes from this one read of the worktree's config.
  const entries = await worktreeConfig(worktree, signal)
  const carriedKey = new RegExp(carriedPattern, "u")
  const carried = entries.filter(({ key }) => carriedKey.test(key)).map(({ key, value }): [string, string] => [key, value ?? "true"])
  const last = (key: string) => carried.filter(([name]) => name === key).at(-1)?.[1]

  const pins: Array<readonly [string, string]> = []
  for (const key of carriedCoreKeys) {
    const value = last(key)
    if (value !== undefined) pins.push([key, value])
  }
  const storage = last("lfs.storage")
  pins.push(["lfs.storage", storage === undefined || storage === "" ? join(commonDirectory, "lfs") : isAbsolute(storage) ? storage : resolve(commonDirectory, storage)])
  const filterPins = sourceFilterPins(entries, input.reviewed ?? [])
  const lfsPolicy = sourceLfsPolicy(entries, input.reviewed ?? [])
  pins.push(...filterPins, ...lfsPolicy)
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

  // The config the directory reads in place of the person's global and system
  // config (ruling Q319): their entries as the worktree read them, includes
  // already followed and so left out, and every filter policy key once, at
  // the worktree's effective value (as pinned above). A file the person
  // edits afterwards is not read. Repository config is still not in it.
  const snapshotEntries = [
    ...entries.filter(({ scope, key }) => trustedConfigScopes.has(scope) && !/^include(?:if)?\./iu.test(key) && !filterPolicyKey.test(key) && lfsPolicyGroup(key) === undefined),
    ...filterPins.map(([key, value]) => ({ key, value })),
    ...lfsPolicy.map(([key, value]) => ({ key, value })),
  ]
  const snapshot = await writeConfigSnapshot(snapshotEntries)

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
    await fs.rm(snapshot.directory, { recursive: true, force: true })
    throw error
  }

  const environment: NodeJS.ProcessEnv = gitEnvironment()
  for (const name of droppedEnvironment) delete environment[name]
  // The snapshot is the only global config, and no system config is read.
  environment.GIT_CONFIG_GLOBAL = snapshot.file
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_DIR = gitDirectory
  environment.GIT_WORK_TREE = worktree
  environment.GIT_OBJECT_DIRECTORY = join(commonDirectory, "objects")
  if (input.worktreeIndex) environment.GIT_INDEX_FILE = index
  pins.forEach(([key, value], position) => {
    environment[`GIT_CONFIG_KEY_${position}`] = key
    environment[`GIT_CONFIG_VALUE_${position}`] = value
  })
  environment.GIT_CONFIG_COUNT = String(pins.length)
  // The pins are the last values Git reads, and every policy pin is the
  // worktree's own value: the expected map is the worktree's (ruling Q319).
  const effectivePins = new Map<string, string>()
  for (const [key, value] of pins) effectivePins.set(key, value)
  try {
    await refuseUnpinnedFilters(environment, worktree, [...effectivePins])
  } catch (error) {
    await fs.rm(gitDirectory, { recursive: true, force: true })
    await fs.rm(snapshot.directory, { recursive: true, force: true })
    throw error
  }

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
    // The snapshot goes in every case: a Git still running without it reads
    // no global config, and so no filter definition.
    dispose: async () => {
      await fs.rm(snapshot.directory, { recursive: true, force: true })
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

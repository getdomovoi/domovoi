import { execFile, spawn, type PromiseWithChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import { windowsTreeKill } from "./claude-process.js"
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
//   It records its owner process first, and one an earlier daemon left
//   behind is swept away before a new one is made (sweepStaleCheckouts).
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
  gitVersion ??= execute("git", ["--version"], { env: gitEnvironment(), encoding: "utf8" }).then(({ stdout }) => {
    const match = /(\d+)\.(\d+)/u.exec(stdout)
    return match ? [Number(match[1]), Number(match[2])] as [number, number] : undefined
  }, () => undefined)
  return gitVersion
}

// Reads from the worktree: `git config` and `git rev-parse` start no program
// the repository's config names.
async function worktreeGit(worktree: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await execute("git", ["-C", worktree, ...inertRepositoryConfig, ...args], {
    env: gitEnvironment(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
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
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

export type GitProcessResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string }

function abortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal.reason })
  error.name = "AbortError"
  return error
}

// Runs one Git command in a process group of its own (POSIX), feeding its
// output to onStdout, which can stop it. A cancelled or stopped command is
// ended with its whole group, and only while Git has not been reaped: until
// then no other group can take its id, so the signal reaches only processes
// this command started. On Windows the process tree is ended instead.
//
// Ending the group does not prove that every process the command started has
// ended: one can leave the group (setsid). So a killed command still leaves
// its descendants unknown to the restore lease (workspace-restore-lease.ts).
export function runGitProcess(args: readonly string[], options: {
  env: NodeJS.ProcessEnv
  cwd: string
  signal?: AbortSignal | undefined
  onStdout?: (chunk: Buffer, stop: () => void) => void
}): PromiseWithChild<GitProcessResult> {
  const posix = process.platform !== "win32"
  const child = spawn("git", [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: posix,
    windowsHide: true,
  })
  const end = () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    if (!posix) {
      void windowsTreeKill(child.pid).catch(() => { child.kill("SIGKILL") })
      return
    }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  const { signal } = options
  const promise = new Promise<GitProcessResult>((resolvePromise, reject) => {
    const errors: Buffer[] = []
    let errorBytes = 0
    let settled = false
    const finish = () => {
      settled = true
      signal?.removeEventListener("abort", end)
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
    child.once("error", (error) => {
      if (settled) return
      finish()
      reject(error)
    })
    child.once("close", (code, closeSignal) => {
      if (settled) return
      finish()
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      resolvePromise({ code, signal: closeSignal, stderr: Buffer.concat(errors).toString("utf8").trim() })
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

  const launch = async (args: readonly string[], options: IsolatedGitRun, onStdout: (chunk: Buffer, stop: () => void) => void) => {
    input.beforeCommand?.()
    const commandSignal = options.signal === null ? undefined : options.signal ?? signal
    commandSignal?.throwIfAborted()
    const indexed = options.index === undefined ? environment : { ...environment, GIT_INDEX_FILE: options.index }
    const env = options.offline === true ? offline(indexed) : indexed
    return trackRestoreCommand(() => runGitProcess([...inertRepositoryConfig, ...args], { env, cwd: worktree, signal: commandSignal, onStdout }))
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
    dispose: () => fs.rm(gitDirectory, { recursive: true, force: true }),
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
}): Promise<void> {
  const { commit } = input
  const isolated = await openIsolatedGit({ ...input, worktreeIndex: false })
  try {
    const version = await installedGitVersion()
    // Git 2.40 and later read in-tree attributes from the commit alone, not a
    // .gitattributes planted in the new worktree before the checkout. Older Git
    // falls back to such a file, which can still only select a driver the
    // isolated config defines.
    const attributeSource = version !== undefined && (version[0] > 2 || (version[0] === 2 && version[1] >= 40)) ? [`--attr-source=${commit}`] : []
    await isolated.run([...attributeSource, "read-tree", "--reset", "-u", commit])
    // The index names the files just written with their stat data, so the new
    // worktree reads as clean without hashing, and filtering, them again.
    const staged = `${isolated.worktreeIndex}.domovoi-${randomUUID()}`
    await fs.copyFile(join(isolated.gitDirectory, "index"), staged)
    await fs.rename(staged, isolated.worktreeIndex)
  } finally {
    await isolated.dispose()
  }
}

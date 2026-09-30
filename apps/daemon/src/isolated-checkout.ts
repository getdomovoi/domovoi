import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import { gitEnvironment, inertRepositoryConfig } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"
import type { GitFilterSetting } from "./repository-git-filters.js"
import { trackRestoreCommand } from "./workspace-restore-lease.js"

const execute = promisify(execFile)

// Checks a new session worktree out without Git or git-lfs reading any of the
// repository's own config (ruling Q223). The repository's config can name a
// program anywhere Git or git-lfs looks during a checkout: a filter, but also
// core.sshCommand, core.askPass or a credential helper git-lfs starts to fetch
// an object, core.fsmonitor, and whatever else a later version reads. Pinning
// keys one by one cannot keep up, so the checkout runs in a temporary Git
// directory of its own:
//
// - Its config is Git's global and system config, which Git reads as always,
//   and the values below, passed as command-line config. No repository,
//   worktree or included repository config file is read, by Git or by
//   git-lfs, which reads its config through `git config`.
// - It has no hooks (core.hooksPath points nowhere, and it was made without
//   a template) and core.fsmonitor is off.
// - Its object store is empty and borrows the repository's through
//   objects/info/alternates, so the commit is read, never copied.
// - Its info/ holds a copy of the repository's info/attributes and, when
//   sparse checkout is on, the new worktree's sparse-checkout patterns. They
//   are data: attributes can only select a filter driver the isolated config
//   defines, which is the person's own or the exact `git lfs install` line.
// - It lives inside the repository's Git directory, so the person's
//   `includeIf "gitdir:..."` conditions match as they do for the repository.
//
// Carried from the repository's config, as values only (CARRIED_KEYS): the
// core settings that decide what the checkout writes (line endings, symlinks,
// case and Unicode handling, file modes, NTFS and HFS path protection, long
// paths, encoding round trips, sparse checkout); lfs.storage, resolved against
// the repository's Git directory and defaulting to its lfs/ folder, so git-lfs
// reads and writes the repository's own object store; and the exact
// `git lfs install` lines the repository sets (ruling Q207 A). Not carried:
// remotes and every transport setting, so git-lfs can fetch a missing object
// only from an lfs.url the tracked .lfsconfig names, with the person's own
// SSH and credential settings; and extensions other than the object format,
// so a partial clone's missing blob fails the checkout instead of fetching.
// The index is written without split index, untracked cache or sparse index,
// so it can be copied into the new worktree, which is then an ordinary linked
// worktree of the repository.

const carriedKeys = [
  "core.autocrlf", "core.eol", "core.safecrlf", "core.symlinks", "core.ignorecase", "core.precomposeunicode",
  "core.filemode", "core.protectntfs", "core.protecthfs", "core.longpaths", "core.checkroundtripencoding",
  "core.sparsecheckout", "core.sparsecheckoutcone", "lfs.storage",
] as const

// Inherited variables that would point the checkout at another directory,
// object store or attribute source than the ones set here.
const droppedEnvironment = [
  "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_ATTR_SOURCE",
  "GIT_ATTR_NOSYSTEM", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]

let gitVersion: Promise<[number, number] | undefined> | undefined

function installedGitVersion(): Promise<[number, number] | undefined> {
  gitVersion ??= execute("git", ["--version"], { env: gitEnvironment(), encoding: "utf8" }).then(({ stdout }) => {
    const match = /(\d+)\.(\d+)/u.exec(stdout)
    return match ? [Number(match[1]), Number(match[2])] as [number, number] : undefined
  }, () => undefined)
  return gitVersion
}

// Reads from the new worktree: `git config` and `git rev-parse` start no
// program the repository's config names.
async function worktreeGit(worktree: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await execute("git", ["-C", worktree, ...inertRepositoryConfig, ...args], {
    env: gitEnvironment(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
  })).stdout
}

async function carriedValues(worktree: string, signal?: AbortSignal): Promise<Map<string, string>> {
  let output = ""
  try {
    output = await worktreeGit(worktree, ["config", "-z", "--get-regexp", `^(${carriedKeys.map((key) => key.replace(".", String.raw`\.`)).join("|")})$`], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error
  }
  const values = new Map<string, string>()
  for (const record of output.split("\0")) {
    if (record === "") continue
    const newline = record.indexOf("\n")
    // A key with no value is boolean true. The last value wins, as for Git.
    values.set(newline === -1 ? record : record.slice(0, newline), newline === -1 ? "true" : record.slice(newline + 1))
  }
  return values
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function checkOutIsolated(input: {
  worktree: string
  commit: string
  // The new worktree's filter settings as the scan read them: the source of
  // the exact `git lfs install` lines the repository sets.
  settings: readonly GitFilterSetting[]
  signal?: AbortSignal | undefined
}): Promise<void> {
  const { worktree, commit, settings, signal } = input
  const gitPath = async (path: string) => resolve(worktree, (await worktreeGit(worktree, ["rev-parse", "--path-format=absolute", "--git-path", path], signal)).trim())
  const commonDirectory = (await worktreeGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim()
  const objectFormat = (await worktreeGit(worktree, ["rev-parse", "--show-object-format"], signal).catch(() => "sha1")).trim() || "sha1"
  const carried = await carriedValues(worktree, signal)
  const [infoAttributes, sparseCheckout, index] = await Promise.all([gitPath("info/attributes"), gitPath("info/sparse-checkout"), gitPath("index")])

  const pins = new Map<string, string>()
  for (const [key, value] of carried) {
    if (key !== "lfs.storage") pins.set(key, value)
  }
  const storage = carried.get("lfs.storage")
  pins.set("lfs.storage", storage === undefined || storage === "" ? join(commonDirectory, "lfs") : isAbsolute(storage) ? storage : resolve(commonDirectory, storage))
  for (const setting of settings) {
    if (!["system", "global", "unknown"].includes(setting.scope) && isStandardLfsFilterLine(setting.key, setting.value)) pins.set(setting.key, setting.value)
  }
  pins.set("core.splitindex", "false")
  pins.set("core.untrackedcache", "false")
  pins.set("index.sparse", "false")

  const gitDirectory = join(commonDirectory, `domovoi-checkout-${randomUUID()}`)
  try {
    await fs.mkdir(join(gitDirectory, "objects", "info"), { recursive: true })
    await fs.mkdir(join(gitDirectory, "refs", "heads"), { recursive: true })
    await fs.mkdir(join(gitDirectory, "info"), { recursive: true })
    await fs.writeFile(join(gitDirectory, "objects", "info", "alternates"), `${join(commonDirectory, "objects")}\n`)
    await fs.writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/domovoi-checkout\n")
    await fs.writeFile(join(gitDirectory, "config"), objectFormat === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"
      : `[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = ${objectFormat}\n`)
    await copyIfPresent(infoAttributes, join(gitDirectory, "info", "attributes"))
    if (carried.get("core.sparsecheckout") === "true") await copyIfPresent(sparseCheckout, join(gitDirectory, "info", "sparse-checkout"))

    const env: NodeJS.ProcessEnv = gitEnvironment()
    for (const name of droppedEnvironment) delete env[name]
    env.GIT_DIR = gitDirectory
    env.GIT_WORK_TREE = worktree
    let count = 0
    for (const [key, value] of pins) {
      env[`GIT_CONFIG_KEY_${count}`] = key
      env[`GIT_CONFIG_VALUE_${count}`] = value
      count += 1
    }
    env.GIT_CONFIG_COUNT = String(count)
    const version = await installedGitVersion()
    // Git 2.40 and later read in-tree attributes from the commit alone, not a
    // .gitattributes planted in the new worktree before the checkout. Older Git
    // falls back to such a file, which can still only select a driver the
    // isolated config defines.
    const attributeSource = version !== undefined && (version[0] > 2 || (version[0] === 2 && version[1] >= 40)) ? [`--attr-source=${commit}`] : []
    signal?.throwIfAborted()
    await trackRestoreCommand(() => execute("git", [...inertRepositoryConfig, ...attributeSource, "read-tree", "--reset", "-u", commit], {
      cwd: worktree, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
    }))
    // The index names the files just written with their stat data, so the new
    // worktree reads as clean without hashing, and filtering, them again.
    const staged = `${index}.domovoi-${randomUUID()}`
    await fs.copyFile(join(gitDirectory, "index"), staged)
    await fs.rename(staged, index)
  } finally {
    await fs.rm(gitDirectory, { recursive: true, force: true })
  }
}
